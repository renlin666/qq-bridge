"""Collect original QQ message evidence for the authorized local memory backfill. No model output is evidence."""
import pathlib,json,subprocess,re,urllib.request,sys
root=pathlib.Path('/opt/qq-stack/qq-bridge');cfg=json.loads((root/'config.json').read_text());state=root/'state'
c=cfg['snowluma'];req=urllib.request.Request(c['httpUrl'].rstrip('/')+'/get_login_info',data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+c['accessToken']})
with urllib.request.urlopen(req,timeout=8) as r:bot=str(json.load(r)['data']['user_id'])
allow={'group:'+str(x) for x in cfg.get('allow',{}).get('groups',[])}|{'private:'+str(x) for x in cfg.get('allow',{}).get('private',[])}
found={}
def add(key,m):
 if key not in allow or not isinstance(m,dict) or m.get('isSelf') or m.get('truncated'):return
 uid=str(m.get('userId',''));mid=str(m.get('messageId',''));text=m.get('plain',m.get('text',''))
 if not re.fullmatch(r'[1-9]\d{4,11}',uid) or not re.fullmatch(r'-?\d+',mid) or not isinstance(text,str) or not text.strip():return
 if key.startswith('private:') and key!='private:'+uid:return
 if str(m.get('botAccountId',bot))!=bot or not isinstance(m.get('time'),(int,float)):return
 value={'key':key,'message':{'userId':uid,'messageId':mid,'botAccountId':bot,'sender':str(m.get('sender',uid)),
  'text':text,'plain':text,'time':m['time'],'memoryReplay':True}}
 previous=found.get((key,mid))
 if not previous or len(previous['message']['text'])<len(text):found[(key,mid)]=value
for key,st in json.loads((state/'social-v2.json').read_text()).get('conversations',{}).items():
 for m in st.get('recentMessages',[])+st.get('unread',[]):add(key,m)
decoder=json.JSONDecoder()
for key,sid in json.loads((state/'sessions.json').read_text()).get('sessions',{}).items():
 if key not in allow:continue
 for p in pathlib.Path('/var/lib/qq-stack/dsh/sessions').glob('*/'+sid+'/session.v4.jsonl.zstd'):
  raw=subprocess.check_output(['zstd','-dc',str(p)]).decode();calls={}
  for line in raw.splitlines():
   event=json.loads(line);data=event.get('data',{})
   if event.get('type')=='tool/call':calls[data.get('callId')]=data.get('name','')
   if event.get('type')=='user/message':
    for block in data.get('content',[]):
     text=block.get('text','');mark='【本次消息快照】\n';start=text.find(mark)
     if start<0:continue
     try:value,_=decoder.raw_decode(text[start+len(mark):])
     except:continue
     for m in value.get('messages',[])+value.get('recent',[]):add(key,m)
   if event.get('type')=='tool/result':
    msg=data.get('message',{});name=calls.get(msg.get('toolCallId'),'')
    if not re.search(r'qq_(wait_for_messages|get_unread_messages|get_recent_messages|get_message_detail)$',name):continue
    for block in msg.get('content',[]):
     try:value=json.loads(block.get('text',''))
     except:continue
     if not isinstance(value,dict):continue
     for field in ['messages','newMessages','recent']:
      for m in value.get(field,[]) if isinstance(value.get(field),list) else []:add(key,m)
legacy=json.loads((state/'shared-memory.json').read_text()).get('memories',[])
result={'botAccountId':bot,'messages':sorted(found.values(),key=lambda x:x['message']['time']),
 'legacy':[m for m in legacy if m.get('sourceKey') in allow and str(m.get('accountId'))==bot]}
json.dump(result,sys.stdout,ensure_ascii=True)
