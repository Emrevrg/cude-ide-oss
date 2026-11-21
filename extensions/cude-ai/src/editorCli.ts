/** Headless agent commands, not the similarly named desktop editor launchers. */
export const EDITOR_CLIS = [
  {id:'cursor-agent',name:'Cursor Agent',bin:'cursor-agent',model:'Cursor Agent CLI',modelsArgs:['--list-models']},
  {id:'kiro-cli',name:'Kiro',bin:'kiro-cli',aliases:['kiro'],model:'Kiro CLI',modelsArgs:['chat','--list-models','--format','json']},
  {id:'amp-cli',name:'Amp',bin:'amp',model:'Amp CLI'},
  {id:'aider-cli',name:'Aider',bin:'aider',model:'Aider CLI',modelsArgs:['--list-models','','--no-git']},
  {id:'crush-cli',name:'Crush',bin:'crush',model:'Crush CLI'},
  {id:'goose-cli',name:'Goose',bin:'goose',model:'Goose CLI'},
  {id:'kilo-cli',name:'Kilo',bin:'kilo',model:'Kilo CLI',modelsArgs:['models']},
  {id:'cline-cli',name:'Cline',bin:'cline',model:'Cline CLI'},
  {id:'roo-cli',name:'Roo Code',bin:'roo',model:'Roo Code CLI'},
] as const;
export type EditorCliId = typeof EDITOR_CLIS[number]['id'];
export function validCliModel(value:string):boolean{return /^[\w][\w./:@+-]{0,199}$/.test(value)&&!value.includes('//')&&!value.split('/').some(part=>part==='.'||part==='..');}

export function editorCliArgs(id:EditorCliId,prompt:string,model?:string):string[]{
  if(model&&!validCliModel(model))throw new Error('Invalid CLI model ID.');
  const pick=model?['--model',model]:[];
  switch(id){
    case 'cursor-agent':return ['--print','--output-format','text','--mode','ask',...pick,prompt];
    case 'kiro-cli':return ['chat','--no-interactive',...pick,prompt];
    case 'amp-cli':return [...pick,'--execute',prompt];
    case 'aider-cli':return ['--no-auto-commits','--no-dirty-commits','--no-git','--chat-mode','ask','--dry-run','--yes-always',...pick,'--message',prompt];
    case 'crush-cli':return ['run','--quiet',...pick,prompt];
    case 'goose-cli':return ['run','--no-session','--quiet',...pick,'--text',prompt];
    case 'kilo-cli':return ['run',...pick,prompt];
    case 'cline-cli':return ['--plan','--auto-approve','false',...pick,prompt];
    case 'roo-cli':return ['--print','--output-format','text',...pick,prompt];
  }
}

/** Accept only IDs, never save headings, credentials or terminal escape sequences. */
export function parseEditorCliModels(id:EditorCliId,output:string):string[]{
  const text=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  let values:unknown[]=[];
  if(id==='kiro-cli'){
    try{const data=JSON.parse(text);const rows=Array.isArray(data)?data:data.models;
      if(Array.isArray(rows))values=rows.map(row=>typeof row==='string'?row:row?.id??row?.modelId??row?.model_id??row?.name);
    }catch{return [];}
  }else if(id==='cursor-agent'){
    // Cursor: one ID per row, optionally followed by a display name.
    values=text.split(/\r?\n/).map(line=>/^\s*([\w][\w./:@+-]*)\s*(?:$| - |\s{2,})/.exec(line)?.[1]);
  }else if(id==='kilo-cli'){
    values=text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line.includes('/'));
  }else if(id==='aider-cli'){
    values=text.split(/\r?\n/).map(line=>/^\s*-\s+([\w][\w./:@+-]*)\s*$/.exec(line)?.[1]);
  }
  return [...new Set(values.filter((value):value is string=>typeof value==='string'&&validCliModel(value)&&!/^sk[-_]|api[_-]?key|token/i.test(value)))].slice(0,400);
}
