import { flags, SfdxCommand } from '@salesforce/command';
import { Connection, SfdxError } from '@salesforce/core';
import chalk from 'chalk';
import fs = require('fs-extra');
import jsToXml = require('js2xmlparser');
import { Field } from 'jsforce/describe-result';

import { fixExistingDollarSign, getExisting } from '../../../shared/getExisting';
import { setupArray } from '../../../shared/setupArray';
import { getParsed } from '../../../shared/xml2jsAsync';

import * as options from '../../../shared/js2xmlStandardOptions';

let conn: Connection;
let objectDescribe: Map<string, Map<string, Field>>;
let resolvedDescribePromises = 0;

export default class PermSetCreate extends SfdxCommand {
    public static description = 'create or add stuff to a permset with maximum access';

    public static examples = [
        `sfdx shane:permset:create -n MyPermSet1 -o Something__c -f Some_Field__c
    // create a permset in force-app/main/default for the object/field.  If MyPermSet1 doesn't exist, it will be created.
    `,
        `sfdx shane:permset:create -n MyPermSet1 -o Something__c
    // create a permset in force-app/main/default for every field on Something__c.
    `,
        `sfdx shane:permset:create -n MyPermSet1
    // create a permset in force-app/main/default for every field on every object!
    `,
        `sfdx shane:permset:create -n MyPermSet1 -t
    // create a permset in force-app/main/default for every field on every object.  If there's a tab for any of those objects, add that tab to the permset, too
    `,
        `sfdx shane:permset:create -n MyPermSet1 -c
    // create a permset in force-app/main/default for every field on every object, checking on org that all fields are permissionable
    `
    ];

    protected static flagsConfig = {
        name: flags.string({
            char: 'n',
            required: true,
            description: "path to existing permset.  If it exists, new perms will be added to it.  If not, then it'll be created for you"
        }),
        object: flags.string({
            char: 'o',
            description: 'API name of an object to add perms for.  If blank, then you mean ALL the objects and ALL their fields and ALL their tabs'
        }),
        field: flags.string({
            char: 'f',
            description: 'API name of an field to add perms for.  Required --object If blank, then you mean all the fields',
            dependsOn: ['object']
        }),
        directory: flags.directory({
            char: 'd',
            default: 'force-app/main/default',
            description: 'Where is all this metadata? defaults to force-app/main/default'
        }),
        tab: flags.boolean({ char: 't', description: 'also add the tab for the specified object (or all objects if there is no specified objects)' }),
        checkpermissionable: flags.boolean({
            char: 'c',
            description: "some fields'permissions can't be deducted from metadata, use describe on org to check if field is permissionable"
        }),
        verbose: flags.builtin()
    };

    // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
    protected static requiresProject = true;
    protected static supportsUsername = true;

    // tslint:disable-next-line:no-any
    public async run(): Promise<any> {
        // fail early on lack of username
        if (this.flags.checkpermissionable && !this.org) {
            throw new SfdxError(`username is required when using --checkpermissionable`);
        }

        objectDescribe = new Map<string, Map<string, Field>>();

        // validations
        if (this.flags.field && !this.flags.object) {
            this.ux.error(chalk.red('If you say a field, you have to say the object'));
        }

        const targetFilename = `${this.flags.directory}/permissionsets/${this.flags.name}.permissionset-meta.xml`;
        const targetLocationObjects = `${this.flags.directory}/objects`;

        if (this.flags.field && !fs.existsSync(`${targetLocationObjects}/${this.flags.object}/fields/${this.flags.field}.field-meta.xml`)) {
            this.ux.error(`Field does not exist: ${this.flags.fields}`);
            return;
        }

        let existing = await getExisting(targetFilename, 'PermissionSet', {
            '@': {
                xmlns: 'http://soap.sforce.com/2006/04/metadata'
            },
            hasActivationRequired: 'false',
            label: this.flags.name
        });

        const objectList: Set<string> = new Set<string>();

        if (!this.flags.object) {
            const files = fs.readdirSync(targetLocationObjects);
            files.forEach(file => objectList.add(file));
        } else {
            objectList.add(this.flags.object);
        }

        this.ux.log(`Object list is ${objectList}`);

        if (this.flags.checkpermissionable) {
            conn = this.org.getConnection();

            this.ux.startSpinner('Getting objects describe from org');

            if (objectList.has('Activity')) {
                // Describe call doesn't work with Activity, but works with Event & Task
                // Both of them can be used for fieldPermissions
                objectList.delete('Activity');
                objectList.add('Event');
                objectList.add('Task');
            }

            // Calling describe on all sObjects - don't think you can do this in only 1 call
            const describePromises = [];

            for (const objectName of objectList) {
                describePromises.push(
                    this.getFieldsPermissions(objectName)
                        .then(result => {
                            objectDescribe.set(objectName, result);
                            resolvedDescribePromises++;
                            this.ux.setSpinnerStatus(`${resolvedDescribePromises}/${objectList.size}`);
                        })
                        .catch(err => {
                            err.objectName = objectName;
                            throw err;
                        })
                );
            }

            await Promise.all(describePromises)
                .then(() => {
                    this.ux.stopSpinner('Done.');
                })
                .catch(err => {
                    // Looks like the process is still waiting for other promises to resolve before exiting, how to avoid that ?
                    this.ux.stopSpinner(err);
                    throw new SfdxError(`Unable to get describe for object ${err.objectName}`);
                });
        }

        // do the objects
        for (const obj of objectList) {
            if (fs.existsSync(`${targetLocationObjects}/${obj}`)) {
                existing = this.addObjectPerms(existing, obj);

                if (this.flags.field) {
                    existing = await this.addFieldPerms(existing, this.flags.object, this.flags.field);
                } else {
                    // all the fields
                    existing = await this.addAllFieldPermissions(existing, obj);
                }

                if (this.flags.tab && fs.existsSync(`${this.flags.directory}/tabs/${obj}.tab-meta.xml`)) {
                    // we're doing tabs, and there is one, so add it to the permset
                    existing = this.addTab(existing, obj);
                }
            } else {
                this.ux.error(chalk.red(`Couldn\'t find that object in ${targetLocationObjects}/${this.flags.object}`));
            }
        }

        existing = await fixExistingDollarSign(existing);

        fs.ensureDirSync(`${this.flags.directory}/permissionsets`);

        // conver to xml and write out the file
        const xml = jsToXml.parse('PermissionSet', existing, options.js2xmlStandardOptions);
        fs.writeFileSync(targetFilename, xml);

        this.ux.log(chalk.green(`Permissions added in ${targetFilename}`));
        return existing; // for someone who wants the JSON?
    }

    public addObjectPerms(existing, objectName: string) {
        // tslint:disable-next-line:no-any
        // make sure it the parent level objectPermissions[] exists

        existing = setupArray(existing, 'objectPermissions');

        if (
            existing.objectPermissions.find(e => {
                return e.object === objectName;
            })
        ) {
            this.ux.log(`Object Permission already exists: ${objectName}.  Nothing to add.`);
            return existing;
        } else if (objectName.endsWith('__c')) {
            this.ux.log(`Added regular object perms for ${objectName}`);
            existing.objectPermissions.push({
                allowCreate: 'true',
                allowDelete: 'true',
                allowEdit: 'true',
                allowRead: 'true',
                modifyAllRecords: 'true',
                object: objectName,
                viewAllRecords: 'true'
            });
        } else if (objectName.endsWith('__e')) {
            this.ux.log(`Added object perms for platform event ${objectName}`);
            existing.objectPermissions.push({
                allowCreate: 'true',
                allowRead: 'true',
                object: objectName
            });
        } else if (objectName.endsWith('__b')) {
            this.ux.log(`Added object perms for big object ${objectName}`);
            existing.objectPermissions.push({
                allowCreate: 'true',
                allowRead: 'true',
                object: objectName
            });
        }
        return existing;
    }

    public async addFieldPerms(existing, objectName: string, fieldName: string) {
        // tslint:disable-next-line:no-any
        // make sure it the parent level objectPermissions[] exists
        const targetLocationObjects = `${this.flags.directory}/objects`;

        existing = setupArray(existing, 'fieldPermissions');

        if (
            existing.fieldPermissions.find(e => {
                return e.field === `${objectName}.${fieldName}`;
            })
        ) {
            this.ux.log(`Field Permission already exists: ${objectName}.${fieldName}.  Nothing to add.`);
            return existing;
        } else {
            // get the field
            if (this.flags.checkpermissionable) {
                // Use org instead to know if field is creatable/updatable/permissionable
                if (objectDescribe.has(objectName) && objectDescribe.get(objectName).has(fieldName)) {
                    const fieldDescribe = objectDescribe.get(objectName).get(fieldName);

                    // Check we can add permission, for instance mandatory fields are readable and editable anyway
                    // Adding access rights to them will throw an error
                    if (fieldDescribe.permissionable) {
                        const editable = fieldDescribe.createable && fieldDescribe.updateable;
                        existing.fieldPermissions.push({
                            readable: 'true',
                            editable: `${editable}`,
                            field: `${objectName}.${fieldName}`
                        });
                        this.ux.log(`Read${editable ? '/Edit' : ''} permission added for field ${objectName}/${fieldName} `);
                    }
                } else {
                    this.ux.warn(chalk.yellow(`field not found on org: ${objectName}/${fieldName}`));
                }
            } else if (fs.existsSync(`${targetLocationObjects}/${objectName}/fields/${fieldName}.field-meta.xml`)) {
                // tslint:disable-next-line: no-any
                const fieldJSON = <any>(
                    await getParsed(await fs.readFile(`${targetLocationObjects}/${objectName}/fields/${fieldName}.field-meta.xml`))
                );

                if (this.flags.verbose) {
                    this.ux.logJson(fieldJSON);
                }

                // Is it required at the DB level?
                if (
                    fieldJSON.CustomField.required === 'true' ||
                    fieldJSON.CustomField.type === 'MasterDetail' ||
                    !fieldJSON.CustomField.type ||
                    fieldJSON.CustomField.fullName === 'OwnerId'
                ) {
                    this.ux.log(`required field ${objectName}/${fieldName} needs no permissions `);
                } else if (fieldJSON.CustomField.type === 'Summary' || fieldJSON.CustomField.type === 'AutoNumber' || fieldJSON.CustomField.formula) {
                    // these are read-only types
                    existing.fieldPermissions.push({
                        readable: 'true',
                        field: `${objectName}.${fieldName}`
                    });
                    this.ux.log(`Read-only permission added for field ${objectName}/${fieldName} `);
                } else {
                    existing.fieldPermissions.push({
                        readable: 'true',
                        editable: 'true',
                        field: `${objectName}.${fieldName}`
                    });
                    this.ux.log(`Read/Edit permission added for field ${objectName}/${fieldName} `);
                }
            } else {
                throw new Error(`field not found: ${objectName}/${fieldName}`);
            }

            return existing;
        }
    }

    // add field permissions
    public async addAllFieldPermissions(existing, objectName: string) {
        // get all the fields for that object
        this.ux.log(`------ going to add all fields for ${objectName}`);
        const fieldsLocation = `${this.flags.directory}/objects/${objectName}/fields`;

        if (!fs.existsSync(fieldsLocation)) {
            this.ux.warn(chalk.yellow(`there is no fields folder at ${fieldsLocation}`));
            return existing;
        }

        const fields = fs.readdirSync(fieldsLocation);

        // iterate through the field builder thing
        for (const fieldFileName of fields) {
            existing = await this.addFieldPerms(existing, objectName, fieldFileName.split('.')[0]);
        }

        return existing;
    }

    public addTab(existing, objectName: string) {
        // only __c and __x

        // this.ux.log(`doing tab for ${objectName}`);

        if (!(objectName.includes('__c') || objectName.includes('__x'))) {
            this.ux.warn(chalk.yellow(`Tab for this object type is not supported: ${objectName}`));
            return existing;
        }

        existing = setupArray(existing, 'tabSettings');

        existing.tabSettings.push({
            tab: objectName,
            visibility: 'Visible'
        });

        this.ux.log(`added tab permission for ${objectName}`);

        // this.ux.log('existing, after all modification is');
        // this.ux.logJson(existing);
        return existing;
    }

    public async getFieldsPermissions(objectName: string) {
        const fieldsPermissions: Map<string, Field> = new Map<string, Field>();
        const describeResult = await conn.sobject(objectName).describe();

        for (const field of describeResult.fields) {
            fieldsPermissions.set(field.name, field);
        }

        return fieldsPermissions;
    }
}
