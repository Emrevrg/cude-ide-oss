import {type EditorCliId} from './editorCli';
export type CudeLocalCli = 'codex-cli'|'claude-code'|'opencode-cli'|'gemini-cli'|'qwen-code'|EditorCliId;

export const localCliAuth:Readonly<Record<CudeLocalCli,readonly string[]>>={
  'codex-cli':['OPENAI_API_KEY','CODEX_HOME'],
  'claude-code':['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CONFIG_DIR'],
  'opencode-cli':[],
  'gemini-cli':['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS'],
  'qwen-code':['QWEN_API_KEY','DASHSCOPE_API_KEY'],
  'cursor-agent':['CURSOR_API_KEY'],
  'kiro-cli':['KIRO_API_KEY'],
  'amp-cli':['AMP_API_KEY'],
  'aider-cli':['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY','DEEPSEEK_API_KEY'],
  'crush-cli':['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'],
  'goose-cli':['GOOSE_PROVIDER','GOOSE_MODEL','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'],
  'kilo-cli':['KILO_API_KEY'],
  'cline-cli':['CLINE_API_KEY'],
  'roo-cli':['OPENROUTER_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY']
};

export function permitsLocalCli(cli:CudeLocalCli,mode:string):boolean{
  if(cli==='codex-cli'||cli==='claude-code')return true;
  return mode==='auto'||mode==='full';
}
