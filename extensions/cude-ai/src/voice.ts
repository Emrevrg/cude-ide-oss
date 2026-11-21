// Voice for Cude AI on Windows without extra installs:
// - recording uses the built-in winmm MCI recorder (16 kHz mono WAV in the temp folder),
// - speech output uses the Windows OneCore voices (e.g. Microsoft Tolga for Turkish),
// - offline dictation falls back to the Windows en-US recognizer when no transcription provider is connected.
// Scripts run through powershell.exe -EncodedCommand; user text only travels over stdin, never through the command line.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { processEnvironment } from './mcpSecurity';

const RECORD_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -Namespace CudeVoice -Name Mci -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string command, System.Text.StringBuilder ret, int len, System.IntPtr hwnd);'
$sb = New-Object System.Text.StringBuilder 256
function M([string]$c) { $r = [CudeVoice.Mci]::mciSendString($c, $sb, 256, [IntPtr]::Zero); if ($r -ne 0) { throw "MCI_$r" } }
M 'open new type waveaudio alias cuderec'
[void][CudeVoice.Mci]::mciSendString('set cuderec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2', $sb, 256, [IntPtr]::Zero)
M 'record cuderec'
[Console]::Out.WriteLine('REC'); [Console]::Out.Flush()
$null = [Console]::In.ReadLine()
M 'stop cuderec'
M ('save cuderec "' + $env:CUDE_WAV + '"')
M 'close cuderec'
[Console]::Out.WriteLine('DONE'); [Console]::Out.Flush()`;

const SPEAK_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -like ($env:CUDE_LANG + '*') } | Select-Object -First 1
if ($v) { $s.Voice = $v }
$stream = Await ($s.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
$fs = [IO.File]::Create($env:CUDE_TTS_OUT); $reader.CopyTo($fs); $fs.Close()
(New-Object System.Media.SoundPlayer $env:CUDE_TTS_OUT).PlaySync()
Remove-Item -LiteralPath $env:CUDE_TTS_OUT -ErrorAction SilentlyContinue`;

const DICTATE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo 'en-US')
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$r.SetInputToWaveFile($env:CUDE_WAV)
$parts = @()
while ($true) { try { $res = $r.Recognize() } catch { break }; if (-not $res) { break }; $parts += $res.Text }
$r.Dispose()
[Console]::Out.Write(($parts -join ' '))`;

const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
function ps(script: string, env: Record<string, string>) {
  const system = process.env.SystemRoot || process.env.WINDIR;
  if (!system || !path.isAbsolute(system)) throw new Error('VOICE_UNSUPPORTED');
  const executable = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], {
    env: { ...processEnvironment(), ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  return child;
}

export const voiceSupported = () => process.platform === 'win32';
const MAX_RECORDING_MS = 120_000;
type Recording = { child: ChildProcessWithoutNullStreams; file: string; ready: Promise<void>;
  exited: Promise<number | null>; timer?: NodeJS.Timeout; stopping: boolean };
let recording: Recording | undefined;
let speaking: ChildProcessWithoutNullStreams | undefined;
let voiceGeneration = 0, speakGeneration = 0;
let starting: Promise<void> | undefined;

export function isRecording() { return !!recording; }
const removeFile = (file:string) => fs.rm(file,{force:true}).catch(()=>undefined);

export async function discardRecording(file:string) {
  await removeFile(file);
  await fs.rmdir(path.dirname(file)).catch(()=>undefined);
}

/** Starts microphone recording. Resolves once the recorder is capturing audio. */
export function startRecording(onExpired:()=>void=()=>undefined):Promise<void> {
  if (starting) return starting;
  if (recording) return recording.ready;
  const generation = ++voiceGeneration;
  starting = beginRecording(generation,onExpired).finally(()=>{starting=undefined;});
  return starting;
}

async function beginRecording(generation:number,onExpired:()=>void) {
  if (!voiceSupported()) throw new Error('VOICE_UNSUPPORTED');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'cude-voice-'));
  const file = path.join(directory,'recording.wav');
  if(generation!==voiceGeneration){await discardRecording(file);throw new Error('VOICE_START_FAILED');}
  let child:ChildProcessWithoutNullStreams;
  try{child=ps(RECORD_SCRIPT,{CUDE_WAV:file});}
  catch(error){await discardRecording(file);throw error;}
  const exited = new Promise<number|null>(resolve=>child.once('close',resolve));
  const ready = new Promise<void>((resolve,reject)=>{
    let output='';
    const timeout=setTimeout(()=>{child.kill();reject(new Error('VOICE_START_TIMEOUT'));},15_000);
    const cleanup=()=>clearTimeout(timeout);
    child.stdout.on('data',chunk=>{
      output=(output+chunk.toString('utf8')).slice(-64);
      if(!output.includes('REC'))return;
      cleanup();resolve();
    });
    child.once('error',()=>{cleanup();reject(new Error('VOICE_START_FAILED'));});
    void exited.then(()=>{cleanup();reject(new Error('VOICE_NO_MICROPHONE'));});
  });
  const current:Recording={child,file,exited,ready,stopping:false};
  recording=current;
  void exited.then(async()=>{
    if(current.stopping)return;
    if(recording===current){recording=undefined;onExpired();}
    if(current.timer)clearTimeout(current.timer);
    await discardRecording(file);
  });
  await ready;
  if(recording!==current||generation!==voiceGeneration)throw new Error('VOICE_START_FAILED');
  current.timer=setTimeout(()=>{cancelRecording();onExpired();},MAX_RECORDING_MS);
}

/** Stops recording and transfers ownership of the WAV to the caller. */
export async function stopRecording():Promise<string> {
  if(starting)await starting;
  const current=recording;
  if(!current||current.stopping)throw new Error('VOICE_NOT_RECORDING');
  current.stopping=true;
  if(current.timer)clearTimeout(current.timer);
  let timer:NodeJS.Timeout|undefined;
  try{
    current.child.stdin.end('stop\n');
    const code=await Promise.race([current.exited,new Promise<null>(resolve=>{
      timer=setTimeout(()=>{current.child.kill();resolve(null);},15_000);
    })]);
    if(code!==0||recording!==current)throw new Error('VOICE_STOP_TIMEOUT');
    const stat=await fs.stat(current.file);
    if(!stat.isFile()||stat.size<2000||stat.size>8_000_000)throw new Error('VOICE_EMPTY');
    return current.file;
  }catch(error){
    void current.exited.then(()=>discardRecording(current.file));
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    if(recording===current)recording=undefined;
  }
}

export function cancelRecording(){
  voiceGeneration++;
  const current=recording;
  recording=undefined;
  if(!current)return;
  if(current.timer)clearTimeout(current.timer);
  current.child.kill();
  void current.exited.then(()=>discardRecording(current.file));
}

/** Offline English dictation with the built-in Windows recognizer. */
export function dictateLocally(file:string,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=ps(DICTATE_SCRIPT,{CUDE_WAV:file});
    let out='',timedOut=false;
    const abort=()=>child.kill();
    const timer=setTimeout(()=>{timedOut=true;abort();},60_000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{if(out.length<20_000)out=(out+chunk.toString('utf8')).slice(0,20_000);});
    child.on('error',()=>undefined);
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(signal?.aborted)reject(signal.reason);
      else if(timedOut)reject(new Error('VOICE_DICTATION_TIMEOUT'));
      else if(code===0)resolve(out.trim());
      else reject(new Error('VOICE_START_FAILED'));
    });
  });
}

/** Removes markdown, code and links so the voice reads the answer naturally. */
export function speakableText(markdown: string, limit = 1800) {
  return markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ').replace(/^#+\s*/gm, '').replace(/[*_>#|~]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim().slice(0, limit);
}

export function stopSpeaking(){
  speakGeneration++;
  if(speaking){speaking.kill();speaking=undefined;}
}

/** Speaks text with a Windows voice for the language (tr → Microsoft Tolga when installed). */
export async function speak(text:string,language:string):Promise<void>{
  if(!voiceSupported())throw new Error('VOICE_UNSUPPORTED');
  stopSpeaking();
  const generation=speakGeneration,clean=speakableText(text);
  if(!clean)return;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cude-tts-'));
  const out=path.join(directory,'speech.wav');
  try{
    if(generation!==speakGeneration)return;
    const child=ps(SPEAK_SCRIPT,{CUDE_LANG:language==='tr'?'tr':'en',CUDE_TTS_OUT:out});
    speaking=child;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>child.kill(),120_000);
      child.once('error',()=>undefined);
      child.once('close',()=>{clearTimeout(timer);if(speaking===child)speaking=undefined;resolve();});
      child.stdin.end(clean, 'utf8');
    });
  }finally{await discardRecording(out);}
}
