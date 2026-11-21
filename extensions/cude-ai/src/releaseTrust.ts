import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {parseReleaseTrust,type ReleaseTrust} from './releaseClient';
export async function readReleaseTrust(context:vscode.ExtensionContext):Promise<ReleaseTrust|undefined>{
 try{return parseReleaseTrust(JSON.parse(await fs.readFile(path.join(context.extensionPath,'release-trust.json'),'utf8')));}
 catch(e:any){if(e.code!=='ENOENT')throw e;}
 // Production builds require an operator-pinned key in the package.
 if(context.extensionMode===1)return undefined;
 const configured=context.globalState.get<ReleaseTrust>('cude.release.trust.v1');
 return configured?parseReleaseTrust(configured):undefined;
}
