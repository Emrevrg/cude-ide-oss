const reservedHeaders=new Set([
  'accept','connection','content-length','content-type','expect','host','keep-alive','mcp-protocol-version',
  'mcp-session-id','origin','te','trailer','transfer-encoding','upgrade'
]);
const unsafeEnv=/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|PYTHON(?:PATH|HOME|STARTUP)|RUBYOPT|PERL5OPT|BASH_ENV|ENV|LD_.*|DYLD_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|GIT_SSH_COMMAND|NPM_CONFIG_SCRIPT_SHELL|COMSPEC|PATH|PATHEXT|SYSTEMROOT|WINDIR)$/i;
const basicEnv = ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL','TERM','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'];
export function processEnvironment(extra: readonly string[] = [], source: NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const requested=new Set([...basicEnv,...extra].map(key=>key.toUpperCase()));
  const env:NodeJS.ProcessEnv={};
  for(const [key,value] of Object.entries(source))if(requested.has(key.toUpperCase())&&typeof value==='string')env[key]=value;
  return env;
}

export function mcpEnvironment(config:unknown, source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const env=processEnvironment([],source);
  if(config===undefined)return env;
  if(!config||Array.isArray(config)||typeof config!=='object')throw new Error('Invalid MCP process environment.');
  const entries=Object.entries(config);
  if(entries.length>32)throw new Error('Too many MCP process variables.');
  const seen=new Set<string>();
  for(const [key,value] of entries){
    const normalized=key.toUpperCase();
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key)||unsafeEnv.test(key)||seen.has(normalized)||
      typeof value!=='string'||value.length>8192||value.includes('\0'))throw new Error('Invalid or restricted MCP process variable.');
    seen.add(normalized);
    const previous=Object.keys(env).find(name=>name.toUpperCase()===normalized);
    if(previous)delete env[previous];
    env[key]=value;
  }
  return env;
}

export function configuredMcpHeaders(value:unknown):Record<string,string>{
  if(value===undefined)return {};
  if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Invalid MCP headers.');
  const entries=Object.entries(value);
  if(entries.length>32)throw new Error('Too many MCP headers.');
  const headers:Record<string,string>=Object.create(null);
  for(const [name,item] of entries){
    const key=name.toLowerCase();
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name)||reservedHeaders.has(key)||/^(proxy-|sec-|x-forwarded-)/.test(key)||
      typeof item!=='string'||item.length>2048||/[^\t\x20-\x7e\x80-\xff]/.test(item)||Object.hasOwn(headers,key))throw new Error('Invalid or restricted MCP header.');
    headers[key]=item;
  }
  return headers;
}

export async function boundedMcpBody(response:Response,limit=1_000_000):Promise<string>{
  if(!response.body)return '';
  const declared=response.headers.get('content-length');
  if(declared&&Number(declared)>limit){
    await response.body.cancel().catch(()=>{});
    throw new Error('MCP response exceeded its size limit.');
  }
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let bytes=0,text='';
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>limit)throw new Error('MCP response exceeded its size limit.');
      text+=decoder.decode(part.value,{stream:true});
    }
    return text+decoder.decode();
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
