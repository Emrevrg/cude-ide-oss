import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export async function installedLocalServer(id:string):Promise<string|undefined>{
 if(process.platform!=='win32')return;
 const local=process.env.LOCALAPPDATA||'',programs=process.env.ProgramFiles||'';
 const candidates=id==='ollama'?[local&&path.join(local,'Programs','Ollama','ollama.exe'),programs&&path.join(programs,'Ollama','ollama.exe')]:id==='lm-studio'?[local&&path.join(local,'Programs','LM Studio','LM Studio.exe'),programs&&path.join(programs,'LM Studio','LM Studio.exe')]:[];
 for(const file of candidates)try{if(file&&path.isAbsolute(file)&&(await fs.stat(file)).isFile())return file;}catch{}
}
export function localRuntimeFailure(detail:string,tr=false){
 if(/out of memory|failed to allocate|cuda.*alloc|insufficient memory/i.test(detail))return tr?'Model için bellek yetersiz. Daha küçük bir GGUF seçin veya diğer uygulamaları kapatın.':'Not enough memory for this model. Choose a smaller GGUF or close other apps.';
 if(/dll|vulkan|cuda|driver/i.test(detail))return tr?'Yerel çalışma motoru veya GPU sürücüsü yüklenemedi. Cude IDE kurulumunu ve ekran kartı sürücüsünü kontrol edin.':'The local runtime or GPU driver could not load. Check the Cude IDE installation and GPU driver.';
 return (tr?'Yerel model başlatılamadı. GGUF dosyasını ve boş belleği kontrol edin. ':'The local model could not start. Check the GGUF file and available memory. ')+detail.slice(-600);
}
export async function connectLocalServer<T>(discover:()=>Promise<string[]>,save:(models:string[])=>Promise<T>,select:(profile:T,model:string)=>Promise<void>){
 const models=await discover();if(!models.length)throw Error('No loaded local models / Yüklü yerel model bulunamadı');
 const profile=await save(models);await select(profile,models[0]);return {profile,models};
}
export function localRuntimeSettings(size:number,device:{ramBytes:number;vramBytes:number}){
 const gib=1024**3, budget=Math.max(0,device.vramBytes-gib);
 // Partial offload uses a conservative layer estimate when GGUF architecture metadata is unavailable.
 const gpuLayers=budget>=size*1.2?999:Math.max(0,Math.min(32,Math.floor(budget/Math.max(1,size)*32)));
 // KV cache grows with model size; small models (≤3 GB) afford 8k context even on 8 GB machines, which the agent needs.
 const context=size<=3*gib&&device.ramBytes>=8*gib?8192:device.ramBytes>=32*gib?8192:device.ramBytes>=16*gib?4096:2048;
 return {gpuLayers,context};
}
