import ctypes as C,sys,json,time,base64
x=C.CDLL('libX11.so.6');t=C.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[C.c_char_p];x.XOpenDisplay.restype=C.c_void_p
d=x.XOpenDisplay(b':1')
if not d:raise RuntimeError('QQ display unavailable')
x.XDefaultRootWindow.argtypes=[C.c_void_p];x.XDefaultRootWindow.restype=C.c_ulong
root=x.XDefaultRootWindow(d)
for name,args in [('XFlush',[C.c_void_p]),('XSync',[C.c_void_p,C.c_int]),('XDestroyImage',[C.c_void_p]),('XCloseDisplay',[C.c_void_p])]:getattr(x,name).argtypes=args
t.XTestFakeMotionEvent.argtypes=[C.c_void_p,C.c_int,C.c_int,C.c_int,C.c_ulong]
t.XTestFakeButtonEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
t.XTestFakeKeyEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
x.XStringToKeysym.argtypes=[C.c_char_p];x.XStringToKeysym.restype=C.c_ulong
x.XKeysymToKeycode.argtypes=[C.c_void_p,C.c_ulong];x.XKeysymToKeycode.restype=C.c_uint
def key(k,down):t.XTestFakeKeyEvent(d,x.XKeysymToKeycode(d,x.XStringToKeysym(k.encode())),down,0)
a=json.load(sys.stdin)
if a['action']=='click':
 t.XTestFakeMotionEvent(d,-1,int(a['x']),int(a['y']),0);x.XFlush(d);time.sleep(.1)
 t.XTestFakeButtonEvent(d,1,1,0);t.XTestFakeButtonEvent(d,1,0,0)
elif a['action']=='key':
 ks=a['key'].split('+')
 for k in ks:key(k,1)
 for k in reversed(ks):key(k,0)
elif a['action']=='type':
 for ch in a['text']:
  if not (ch.isdigit() and ch.isascii()):raise ValueError('only numeric target input')
  key(ch,1);key(ch,0)
elif a['action']=='raise':
 x.XMapRaised.argtypes=[C.c_void_p,C.c_ulong]
 x.XMapRaised(d,int(a['window'],16))
elif a['action']=='screen':
 class XI(C.Structure):
  _fields_=[('width',C.c_int),('height',C.c_int),('xoffset',C.c_int),('format',C.c_int),('data',C.c_void_p),('byte_order',C.c_int),('bitmap_unit',C.c_int),('bitmap_bit_order',C.c_int),('bitmap_pad',C.c_int),('depth',C.c_int),('bytes_per_line',C.c_int),('bits_per_pixel',C.c_int),('red_mask',C.c_ulong),('green_mask',C.c_ulong),('blue_mask',C.c_ulong)]
 x.XGetImage.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_ulong,C.c_int];x.XGetImage.restype=C.POINTER(XI)
 im=x.XGetImage(d,root,0,0,1280,720,0xffffffff,2);v=im.contents
 if v.bits_per_pixel!=32 or v.byte_order!=0:raise RuntimeError('unexpected pixel format')
 raw=C.string_at(v.data,v.bytes_per_line*v.height);rgb=bytearray(v.width*v.height*3)
 for y in range(v.height):
  row=raw[y*v.bytes_per_line:y*v.bytes_per_line+v.width*4];i=y*v.width*3
  rgb[i:i+v.width*3:3]=row[2::4];rgb[i+1:i+v.width*3:3]=row[1::4];rgb[i+2:i+v.width*3:3]=row[0::4]
 sys.stdout.buffer.write(('P6\n%d %d\n255\n'%(v.width,v.height)).encode()+rgb);x.XDestroyImage(im)
else:raise ValueError('unknown action')
x.XSync(d,0);x.XCloseDisplay(d)
