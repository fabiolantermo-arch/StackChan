// Build/sign validation only: no install, cloud deploy, robot flash, or uninstall.
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const build=await mkdtemp(path.join(tmpdir(),'robottino-iphone-check-'));
const result=spawnSync('xcodebuild',['-quiet','-project',path.join(root,'ios/Robottino.xcodeproj'),'-scheme','Robottino','-configuration','Debug','-destination','generic/platform=iOS','-derivedDataPath',build,'-allowProvisioningUpdates','DEVELOPMENT_TEAM=TEAMID0000','build'],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const app=path.join(build,'Build/Products/Debug-iphoneos/Robottino.app');
const signature=spawnSync('codesign',['--verify','--deep','--strict',app],{encoding:'utf8'});
const identity=spawnSync('/usr/libexec/PlistBuddy',['-c','Print CFBundleIdentifier',path.join(app,'Info.plist')],{encoding:'utf8'});
const team=spawnSync('codesign',['-d','--verbose=2',app],{encoding:'utf8'});
if(signature.status!==0||identity.status!==0||identity.stdout.trim()!=='com.example.robottino'||team.status!==0||!team.stderr.includes('TeamIdentifier=TEAMID0000'))throw Error('Firma o identità della build inattese. Nessuna installazione effettuata.');
const output=path.join(root,'work/verification');await mkdir(output,{recursive:true});
await writeFile(path.join(output,'iphone-build.json'),JSON.stringify({time:new Date().toISOString(),app,signatureVerified:true,bundleID:'com.example.robottino',teamVerified:true,installed:false},null,2)+'\n');
console.log('PASS Build iPhone, firma e identità. Nessun dispositivo modificato.');
