// Shared security helpers for Cude AI. Kept dependency-free so tests can load them directly.

// Paths that must never be attached, searched, sent to a model or written by an AI proposal.
// Matching is done on a forward-slash path (relative or absolute) and is case-insensitive.
const SECRET_PATH=new RegExp([
  String.raw`(^|/)\.env(\.|$)`,                                   // .env, .env.local, .env.production
  String.raw`(^|/)[^/]*\.env$`,                                   // prod.env, local.env
  String.raw`(^|/)\.envrc$`,
  String.raw`(^|/)\.(npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass|dockercfg)$`,
  String.raw`(^|/)_netrc$`,
  String.raw`(^|/)\.(ssh|aws|gnupg|kube|docker|azure|gcloud)(/|$)`,
  String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`,
  String.raw`\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|tfvars|tfstate)$`,
  String.raw`\.(pem|key|p12|pfx)(\.|/)`,
  String.raw`(^|/)(secrets?|credentials?)(/|\.|$)`,
  String.raw`(^|/)[^/]*(service[-_]?account|client[-_]?secret)[^/]*\.json$`
].join('|'),'i');

export function isSecretPath(value:string):boolean{
  const normalized=String(value||'').replace(/\\/g,'/');
  return SECRET_PATH.test(normalized);
}

// Removes literal secret values from text that may be shown in the UI or logs.
export function redactSecrets(text:string,secrets:Array<string|undefined|null>):string{
  let result=String(text??'');
  for(const secret of secrets){if(typeof secret==='string'&&secret.length>=6)result=result.split(secret).join('[redacted]');}
  return result;
}

// Replaces {{KEY}} placeholders without interpreting `$&`, `$'`, `` $` `` replacement patterns.
export function fillTemplate(template:string,values:Record<string,string>):string{
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g,(whole,key:string)=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:whole);
}

export const MASKED_SECRET='********';

// Header values are shown to the settings webview as a mask; real values stay in SecretStorage.
export function maskHeaders(headers:Record<string,string>):Record<string,string>{
  return Object.fromEntries(Object.keys(headers||{}).map(name=>[name,MASKED_SECRET]));
}
export function restoreMaskedHeaders(incoming:Record<string,string>,stored:Record<string,string>):Record<string,string>{
  const result:Record<string,string>={};
  for(const [name,value] of Object.entries(incoming||{})){
    if(value===MASKED_SECRET){const previous=Object.entries(stored||{}).find(([key])=>key.toLowerCase()===name.toLowerCase());if(!previous)throw new Error(`Custom header ${name} has no saved value; enter it again.`);result[name]=previous[1];}
    else result[name]=value;
  }
  return result;
}
export function maskProxy(proxy:string):string{
  if(!proxy)return'';
  try{
    const url=new URL(proxy);
    if(url.username)url.username=MASKED_SECRET;
    if(url.password)url.password=MASKED_SECRET;
    return url.toString().replace(/\/$/,'');
  }catch{return'';}
}
export function restoreMaskedProxy(incoming:string,stored:string):string{
  if(!incoming)return'';
  let url:URL;
  try{url=new URL(incoming);}catch{return incoming;}
  const maskedUser=decodeURIComponent(url.username)===MASKED_SECRET;
  const maskedPassword=decodeURIComponent(url.password)===MASKED_SECRET;
  if(!maskedUser&&!maskedPassword)return incoming;
  let previous:URL;
  try{previous=new URL(stored);}catch{throw new Error('The saved proxy credentials are unavailable; enter the proxy URL again.');}
  if(previous.origin!==url.origin||(!maskedUser&&previous.username!==url.username&&maskedPassword)){
    throw new Error('Enter proxy credentials again when changing the proxy endpoint or user.');
  }
  if(maskedUser)url.username=previous.username;
  if(maskedPassword)url.password=previous.password;
  return url.toString().replace(/\/$/,'');
}

export function sameOrigin(a:string,b:string):boolean{
  try{return new URL(a).origin===new URL(b).origin;}catch{return false;}
}

// Control characters other than tab/newline, and Unicode bidi overrides, can hide parts of a command in a confirmation dialog.
export function hasHiddenCommandCharacters(command:string):boolean{
  return /[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/.test(command);
}

// Match token formats with an identifying prefix and complete PEM private keys.
export function redactCredentialLiterals(value:string):string{
  return value.replace(/(?<![\w-])(?:nvapi-[A-Za-z0-9_-]{24,}|cude_[a-f0-9]{64}|gh[pousr]_[A-Za-z0-9]{28,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|hf_[A-Za-z0-9]{24,})/g,'[redacted]')
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,'[redacted]');
}
