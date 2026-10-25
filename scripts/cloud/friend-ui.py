#!/usr/bin/python3
"""Root-owned, fixed-purpose QQ UI worker. Socket peers never supply coordinates or code."""
import csv,io,json,os,pathlib,re,socket,struct,subprocess,sys,time
from PIL import Image,ImageOps

STACK=pathlib.Path('/opt/qq-stack/qq-bridge')
BASE=pathlib.Path('/usr/local/lib/qq-stack/friend-ui')
DATA=pathlib.Path('/var/lib/qq-stack/friend-ui')
SOCKET='/run/qq-friend-ui/control.sock'
CONTAINER='qq-stack-snowluma'
DAY=86400000

def command(args,**kwargs):
 return subprocess.run(args,check=True,capture_output=True,timeout=25,**kwargs).stdout
def x11(action):
 return command(['docker','exec','-i',CONTAINER,'python3','/tmp/qq-friend-x11.py'],input=json.dumps(action).encode())
def frame():return Image.open(io.BytesIO(x11({'action':'screen'}))).convert('RGB')
def ocr(im,psm=6):
 out=io.BytesIO();ImageOps.grayscale(im).resize((im.width*2,im.height*2)).save(out,format='PNG')
 return command(['tesseract','stdin','stdout','-l','chi_sim+eng','--psm',str(psm)],input=out.getvalue()).decode().strip()
def compact(text):return re.sub(r'\s','',text)
def words(im):
 out=io.BytesIO();ImageOps.grayscale(im).resize((im.width*2,im.height*2)).save(out,format='PNG')
 raw=command(['tesseract','stdin','stdout','-l','chi_sim+eng','--psm','11','tsv'],input=out.getvalue()).decode()
 lines={}
 for w in csv.DictReader(raw.splitlines(),delimiter='\t'):
  if not w.get('text','').strip():continue
  k=(w['block_num'],w['par_num'],w['line_num']);lines.setdefault(k,[]).append(w)
 return [(compact(''.join(w['text'] for w in line)),
   (min(int(w['left']) for w in line)+max(int(w['left'])+int(w['width']) for w in line))/4,
   (min(int(w['top']) for w in line)+max(int(w['top'])+int(w['height']) for w in line))/4) for line in lines.values()]
def click(x,y):x11({'action':'click','x':int(x),'y':int(y)});time.sleep(.5)
def key(value):x11({'action':'key','key':value});time.sleep(.2)
def windows():
 tree=command(['docker','exec','-e','DISPLAY=:1','-e','LC_ALL=C.UTF-8',CONTAINER,'xwininfo','-root','-tree']).decode()
 result=[]
 for line in tree.splitlines():
  if '("qq" "QQ")' not in line:continue
  wid=re.search(r'0x[0-9a-f]+',line).group()
  info=command(['docker','exec','-e','DISPLAY=:1','-e','LC_ALL=C.UTF-8',CONTAINER,'xwininfo','-id',wid]).decode()
  if 'Map State: IsViewable' not in info:continue
  def n(label):return int(re.search(re.escape(label)+r':\s*(-?\d+)',info).group(1))
  result.append({'id':wid,'title':re.search(r'Window id: \S+ "(.*)"',info).group(1),'x':n('Absolute upper-left X'),'y':n('Absolute upper-left Y'),'w':n('Width'),'h':n('Height')})
 return result
def onebot(action):
 import urllib.request
 c=json.loads((STACK/'config.json').read_text())['snowluma']
 req=urllib.request.Request(c['httpUrl'].rstrip('/')+'/'+action,data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+c['accessToken']})
 with urllib.request.urlopen(req,timeout=8) as r:out=json.load(r)
 if out.get('retcode')!=0 or out.get('status')!='ok':raise RuntimeError('OneBot read failed')
 return out.get('data')
def approval(ident):
 c=json.loads((STACK/'config.json').read_text())
 ADMIN=str(c.get('ownerQQ',''))
 if not re.fullmatch(r'[1-9][0-9]{4,11}',ADMIN):raise ValueError('administrator is not configured')
 if not re.fullmatch('[a-f0-9]{16}',ident):raise ValueError('invalid request id')
 rows=json.loads((STACK/'state/friend-requests.json').read_text())['requests']
 row=next(r for r in rows if r['id']==ident)
 if row['status']!='dispatching' or row.get('approvedBy')!=ADMIN or row.get('approvalKey')!='private:'+ADMIN or not row.get('approvalMessageId'):
  raise ValueError('missing private administrator approval')
 if not 0<=time.time()*1000-row['approvalAt']<=DAY:raise ValueError('approval expired')
 c=json.loads((STACK/'config.json').read_text());q={**c.get('integrations',{}).get('qzone',{}),**c.get('extensions',{}).get('qzone',{}).get('config',{})}
 mode=json.loads((STACK/'state/mode.json').read_text()).get('mode')
 social=json.loads((STACK/'state/social-v2.json').read_text())
 if mode!='reserved2' or c.get('socialV2',{}).get('enabled') is False or social.get('paused'):raise ValueError('QQ agent paused or mode changed')
 if c.get('extensions',{}).get('qzone',{}).get('enabled') is False or not q.get('enabled') or not q.get('friendsEnabled') or row['key'] not in q.get('allowedKeys',[]):raise ValueError('feature permission revoked')
 for target in [row['key'],'private:'+ADMIN]:
  kind,uin=target.split(':');field='groups' if kind=='group' else 'private'
  if uin in list(map(str,c.get('deny',{}).get(field,[]))) or uin not in list(map(str,c.get('allow',{}).get(field,[]))):raise ValueError('conversation permission revoked')
 if str(onebot('get_login_info')['user_id'])!=row['accountId']:raise ValueError('logged in account changed')
 return row
def is_friend(target):
 friends=onebot('get_friend_list')
 if not isinstance(friends,list):raise ValueError('invalid friend list')
 return any(str(f['user_id'])==target for f in friends)
def result_button(row,target):
 # Keep separators: joining all digits can merge a nickname, QQ and age.
 if not re.fullmatch(r'[1-9][0-9]{4,11}',str(target)):return None
 text=ocr(row)
 fields=re.findall(r'[（(]\s*([1-9][0-9]{4,11})\s*[)）]|(?<![A-Za-z])QQ\s*[:：]?\s*([1-9][0-9]{4,11})(?![0-9])',text,re.I)
 ids=[a or b for a,b in fields]
 if ids!=[target]:return None
 # This crop contains exactly the first result row in the verified layout.
 buttons=[(x,y) for label,x,y in words(row) if label=='添加'
  and row.width-100<=x<=row.width-8 and 8<=y<=row.height-8]
 return buttons[0] if len(buttons)==1 else None

def search(target):
 command(['docker','cp',str(BASE/'qq-x11.py'),CONTAINER+':/tmp/qq-friend-x11.py'])
 ws=windows();search_window=next((w for w in ws if w['title']=='综合搜索' and w['w']==680),None)
 if not search_window:
  main=next((w for w in ws if w['w']==960 and w['h']==595),None)
  if not main:raise ValueError('QQ主窗口布局变化，需在noVNC恢复窗口后人工核实')
  x11({'action':'raise','window':main['id']});time.sleep(1);key('Escape')
  click(main['x']+280,main['y']+66)
  for _ in range(6):
   time.sleep(1);menu=compact(ocr(frame().crop((main['x']+295,main['y']+115,main['x']+380,main['y']+146)),7))
   if '好友' in menu:break
  else:raise ValueError('没有识别到添加好友菜单，已停止')
  click(main['x']+330,main['y']+131)
  for _ in range(10):
   time.sleep(1);ws=windows();search_window=next((w for w in ws if w['title']=='综合搜索' and w['w']==680),None)
   if search_window:break
 if not search_window:raise ValueError('无法打开综合搜索，已停止')
 w=search_window;x,y=w['x'],w['y']
 x11({'action':'raise','window':w['id']});time.sleep(.7)
 for _ in range(10):
  if '用户' in compact(ocr(frame().crop((x,y,x+680,y+125)))):break
  time.sleep(1)
 else:raise ValueError('综合搜索未加载或布局变化')
 click(x+107,y+96);click(x+220,y+55);key('Control_L+a');x11({'action':'type','text':target});click(x+622,y+55)
 for _ in range(12):
  time.sleep(1);im=frame();row=im.crop((x+12,y+117,x+670,y+185));button=result_button(row,target)
  if button is not None:return w,row,button
 raise ValueError('未能同时确认搜索结果的完整QQ号和添加按钮；未点击添加')
def outcome(ident,status,detail,im=None):
 if im is not None:im.save(DATA/(ident+'-'+status+'.png'))
 return {'status':status,'detail':detail}
def perform(ident,dry_target=None):
 DATA.mkdir(parents=True,exist_ok=True,mode=0o700)
 if dry_target:
  w,row,button=search(dry_target);return outcome('dry-run','dry_run_ready','已核对完整QQ号和添加按钮，未点击添加',row)
 row=approval(ident);target=row['targetUserId']
 if is_friend(target):return outcome(ident,'friends','真实好友列表确认已是好友，未发送重复申请。')
 journal=DATA/(ident+'.json')
 if journal.exists():return json.loads(journal.read_text())
 w,crop,button=search(target);approval(ident)
 # Recheck the visible row after approval checks, immediately before reserving.
 crop=frame().crop((w['x']+12,w['y']+117,w['x']+670,w['y']+185))
 button=result_button(crop,target)
 if button is None:raise ValueError('点击前目标QQ号或添加按钮已变化，已停止')
 # Reserve before the first action that could send, including one-click adds.
 reserved=outcome(ident,'uncertain','客户端添加已开始；若进程中断，禁止自动重试。')
 journal.write_text(json.dumps(reserved,ensure_ascii=False));crop.save(DATA/(ident+'-target.png'))
 click(w['x']+12+button[0],w['y']+117+button[1])
 result=None
 for _ in range(8):
  time.sleep(1)
  if is_friend(target):result=outcome(ident,'friends','真实好友列表已确认添加成功。');break
  im=frame();text=compact(ocr(im))
  if any(v in text for v in ['验证码','安全验证','验证问题','回答问题','请输入答案','滑块','短信验证']):
   result=outcome(ident,'paused_verification','QQ要求额外验证，已暂停；请管理员在noVNC完成验证并人工核实结果。');break
  if any(v in text for v in ['申请已发送','请求已发送','发送成功','等待对方验证','好友请求已发送']):
   result=outcome(ident,'request_submitted','QQ界面确认好友申请已提交，等待对方同意；尚未确认成为好友。');break
  # Only a recognized verification-message dialog can lead to a Send click.
  if '验证消息' in text and '添加好友' in text and '取消' in text:
   send=[(tx,ty) for s,tx,ty in words(im) if s=='发送']
   if len(send)!=1:
    result=outcome(ident,'paused_ui','已打开好友验证消息窗口，但无法唯一确认发送按钮，已暂停。');break
   approval(ident);click(*send[0])
   for _ in range(8):
    time.sleep(1)
    if is_friend(target):result=outcome(ident,'friends','真实好友列表已确认添加成功。');break
    text=compact(ocr(frame()))
    if any(v in text for v in ['验证码','安全验证','验证问题','滑块']):result=outcome(ident,'paused_verification','提交时出现验证，已暂停，请在noVNC核实。');break
    if any(v in text for v in ['申请已发送','请求已发送','发送成功','等待对方验证','好友请求已发送']):result=outcome(ident,'request_submitted','QQ界面确认申请已提交，等待对方同意。');break
   break
 if result is None:result=outcome(ident,'uncertain','已操作添加，但QQ未显示可确认的提交结果；已暂停，请在noVNC核实，禁止自动重试。')
 journal.write_text(json.dumps(result,ensure_ascii=False));return result
def serve():
 os.umask(0o077)
 pathlib.Path(SOCKET).unlink(missing_ok=True)
 server=socket.socket(socket.AF_UNIX);server.bind(SOCKET);os.chmod(SOCKET,0o660)
 import pwd,grp
 os.chown(SOCKET,0,grp.getgrnam('qqbot').gr_gid);server.listen(2)
 expected=pwd.getpwnam('qqbot').pw_uid
 while True:
  connection,_=server.accept()
  with connection:
   ident=None
   try:
    _,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
    if uid!=expected:raise ValueError('invalid peer')
    connection.settimeout(3);raw=b''
    while b'\n' not in raw and len(raw)<=200:
     chunk=connection.recv(201)
     if not chunk:raise ValueError('incomplete request')
     raw+=chunk
    value=json.loads(raw);ident=value['id']
    if set(value)!={'id'}:raise ValueError('unsupported arguments')
    result=perform(ident)
   except Exception as error:
    journal=DATA/(str(locals().get('ident',''))+'.json')
    result=json.loads(journal.read_text()) if re.fullmatch('[a-f0-9]{16}',str(locals().get('ident',''))) and journal.exists() else {'status':'paused_ui','detail':'客户端前置校验失败或界面变化，已暂停；请管理员在noVNC核实。'}
    print('friend-ui paused:',type(error).__name__,str(error),flush=True)
   try:connection.sendall((json.dumps(result,ensure_ascii=False)+'\n').encode())
   except OSError:pass
if __name__=='__main__':
 if len(sys.argv)==3 and sys.argv[1]=='--dry-run' and re.fullmatch(r'[1-9]\d{4,11}',sys.argv[2]):print(json.dumps(perform('',sys.argv[2]),ensure_ascii=False))
 elif len(sys.argv)==2 and sys.argv[1]=='--serve':serve()
 else:raise SystemExit('fixed-purpose worker: --serve or --dry-run QQ')
