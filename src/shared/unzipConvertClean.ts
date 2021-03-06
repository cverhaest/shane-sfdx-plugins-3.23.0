import { UX } from '@salesforce/command';
import fs = require('fs-extra');
import unzipper = require('unzipper');

import { exec } from '../shared/execProm';

export async function retrieveUnzipConvertClean(tmpDir, retrieveCommand, target) {
    const ux = await UX.create();

    process.stdout.write('Starting retrieval...');
    await fs.ensureDirSync(tmpDir);

    try {
        await exec(retrieveCommand, { maxBuffer: 1000000 * 1024 });
    } catch (e) {
        ux.error(e);
    }

    process.stdout.write('done.  Unzipping...');

    await extract(tmpDir);

    try {
        // const convertResult = await exec(`sfdx force:mdapi:convert -r ./${tmpDir} -d ${target} --json`);
        await exec(`sfdx force:mdapi:convert -r ./${tmpDir} -d ${target} --json`);
        // process.stdout.write(`done (converted ${JSON.parse(convertResult.stdout).result.length} items).  Cleaning up...`);
        await fs.remove(tmpDir);
    } catch (err) {
        ux.errorJson(err);
        // ux.error('Error from conversion--it may have been too much metadata');
    }

    await fs.remove(tmpDir);
    process.stdout.write('Done!\n');
}

const extract = (location: string) => {
    return new Promise((resolve, reject) => {
        fs.createReadStream(`./${location}/unpackaged.zip`)
            .pipe(unzipper.Extract({ path: `${location}` }))
            .on('close', () => {
                process.stdout.write('done.  Converting...');
                resolve();
            })
            .on('error', error => reject(error));
    });
};
