import http from 'node:http';

// Fixed, deployment-owned Unix socket. No audio/path/URL is sent to an external service.
export function transcribeSocket(audio, socketPath, {timeoutMs=240000}={}) {
  return new Promise((resolve,reject)=>{
    if(!Buffer.isBuffer(audio)||audio.length<46||audio.length>8*1024*1024)return reject(new Error('音轨WAV大小无效'));
    const req=http.request({socketPath,path:'/transcribe',method:'POST',headers:{'content-type':'audio/wav','content-length':audio.length}},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>128*1024)res.destroy(new Error('转写返回过大'));else chunks.push(b);});
      res.on('error',reject);res.on('end',()=>{try{
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(res.statusCode!==200)throw new Error(result.error||'音轨转写失败');resolve(result);
      }catch(error){reject(error);}});
    });
    req.on('error',reject);req.setTimeout(timeoutMs,()=>req.destroy(new Error('音轨转写超时')));req.end(audio);
  });
}
