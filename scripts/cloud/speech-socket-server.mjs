import http from 'node:http';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import fs from 'node:fs';

// systemd socket activation keeps model inference outside the bridge's cgroup.
// The socket is mode 0600; one job loads the existing DSH SenseVoice worker,
// then kills it so idle QQ operation retains its memory.
const modelDirectory='/opt/qq-stack/models/sensevoice';
const worker='/opt/qq-stack/runtime/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js';
const maxAudioBytes=8*1024*1024;let busy=false;
async function recognize(audio){
 const available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
 if(!Number.isFinite(available)||available<384*1024)throw new Error('转写暂缓：主机可用内存不足384MiB');
 const token=randomBytes(32).toString('hex');
 const config={dataRoot:modelDirectory,model:modelDirectory+'/model.int8.onnx',tokens:modelDirectory+'/tokens.txt',vad:modelDirectory+'/silero_vad.onnx',threads:1,segmentSeconds:12,maxAudioBytes,maxResponseBytes:128*1024};
 const child=spawn(process.execPath,[worker,JSON.stringify(config)],{stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_SPEECH_TOKEN:token,NODE_OPTIONS:'--max-old-space-size=64'}});
 let stdout='',stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-500);});
 const kill=()=>child.kill('SIGKILL');process.once('exit',kill);const timeout=setTimeout(kill,240000);
 try{
  const port=await new Promise((resolve,reject)=>{
   child.once('error',reject);child.once('close',()=>reject(new Error('转写进程退出：'+stderr)));
   child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024){kill();return reject(new Error('转写启动信息异常'));}if(stdout.includes('\n'))try{const p=JSON.parse(stdout.split('\n')[0]).port;if(!Number.isInteger(p)||p<1||p>65535)throw new Error('转写端口异常');resolve(p);}catch(e){reject(e);}});
  });
  const response=await fetch(`http://127.0.0.1:${port}/transcribe?language=auto`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'audio/wav'},body:audio,signal:AbortSignal.timeout(230000)});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'识别失败');return value;
 }finally{clearTimeout(timeout);kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('close',r);});process.removeListener('exit',kill);}
}
const server=http.createServer(async(req,res)=>{
 const reply=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));};
 if(req.method!=='POST'||req.url!=='/transcribe'){req.resume();reply(404,{error:'Unknown endpoint'});return;}
 const size=Number(req.headers['content-length']);
 if(!Number.isSafeInteger(size)||size<46||size>maxAudioBytes||req.headers['transfer-encoding']){req.resume();reply(413,{error:'音轨大小无效'});return;}
 if(busy){req.resume();reply(429,{error:'音轨转写正在处理，请稍后再试'});return;}
 busy=true;
 try{
  const chunks=[];let received=0;for await(const b of req){received+=b.length;if(received>size)throw new Error('音轨大小不一致');chunks.push(b);}
  if(received!==size)throw new Error('音轨不完整');
  const value=await recognize(Buffer.concat(chunks));reply(200,value);
 }catch(error){reply(503,{error:String(error.message).slice(0,300)});}
 finally{busy=false;}
});
server.requestTimeout=300000;server.headersTimeout=10000;
if(process.env.LISTEN_FDS!=='1'||Number(process.env.LISTEN_PID)!==process.pid)throw new Error('Requires systemd socket activation');
server.listen({fd:3});
