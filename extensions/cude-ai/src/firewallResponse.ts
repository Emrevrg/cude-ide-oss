import * as vscode from 'vscode';
import {firewallMessage} from './heartbeatWire';
export async function observeFirewallResponse(response:any){
 if(response.status!==403)return;
 let code:unknown;try{const body=await response.clone().json();code=body.error?.code||body.code;}catch{return;}
 const message=firewallMessage(code,vscode.workspace.getConfiguration('cude-ai').get<string>('language','en'));
 if(message){await response.body?.cancel();throw Error(message);}
}
