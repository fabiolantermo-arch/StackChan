// Compile the unchanged production model on macOS, excluding the iOS view declarations.
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const source=await readFile(new URL('./Robottino/Sources.swift',import.meta.url),'utf8');
const boundary=source.indexOf('@main struct RobottinoApp: App');
if(boundary<0)throw Error('Production model boundary missing');
const temporary=await mkdtemp(path.join(tmpdir(),'robottino-store-test-'));
const model=path.join(temporary,'ProductionStore.swift'),binary=path.join(temporary,'connection-test');
await writeFile(model,source.slice(0,boundary));
const target=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`;
const compile=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5','-target',target,'-module-cache-path',path.join(temporary,'ModuleCache'),model,new URL('./Robottino/RobotLiveCore.swift',import.meta.url).pathname,new URL('./test-connection.swift',import.meta.url).pathname,'-o',binary],{stdio:'inherit'});
if(compile.status!==0)process.exit(compile.status??1);
const run=spawnSync(binary,[],{stdio:'inherit'});process.exit(run.status??1);
