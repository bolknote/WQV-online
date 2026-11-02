"""Execute PCLink3.exe's original calendar encoder, without running Windows.

Only the year-length helper is replaced by the Gregorian day count; all wire
packing instructions at 0040A0E0 are executed by Unicorn.
"""
from pathlib import Path
import struct, calendar, hashlib, json, argparse
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EIP,UC_X86_REG_EAX
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('executable',type=Path,help='Original Casio WQV Link 3 PCLink3.exe')
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'tests/fixtures/wqv10-calendar-original.json')
args=parser.parse_args()
binary=args.executable.read_bytes()
pe=struct.unpack_from('<I',binary,60)[0];opt=pe+24;base=struct.unpack_from('<I',binary,opt+28)[0]
u=Uc(UC_ARCH_X86,UC_MODE_32);u.mem_map(base,(struct.unpack_from('<I',binary,opt+56)[0]+4095)&~4095)
s=opt+struct.unpack_from('<H',binary,pe+20)[0]
for i in range(struct.unpack_from('<H',binary,pe+6)[0]):
 vs,va,rs,off=struct.unpack_from('<IIII',binary,s+40*i+8)
 if rs:u.mem_write(base+va,binary[off:off+rs])
obj=0x2000000;stack=0x3000000;stop=0x4000000
u.mem_map(obj,0x20000);u.mem_map(stack,0x10000);u.mem_map(stop,0x1000)
u.mem_write(obj+0xbe0,bytes([0xa5])*7305)
samples=[[2000,1,1,1],[2000,2,29,2],[2001,1,1,3],[2019,12,31,3],[2020,1,1,2],[2020,2,29,3],[2039,12,31,1]]
# Deliberately fill unused UI day slots with nonzero values. They must not leak.
for y in range(2000,2040):
 days=366 if calendar.isleap(y) else 365
 for d in range(days,368):u.mem_write(obj+0x286c+((y-2000)*368+d)*4,struct.pack('<I',0xdeadbeef))
for y,m,d,c in samples:
 ordinal=sum(calendar.monthrange(y,mm)[1] for mm in range(1,m))+d-1
 u.mem_write(obj+0x286c+((y-2000)*368+ordinal)*4,struct.pack('<I',c))
def hook(u,address,size,data):
 if address==0x409fb0:
  sp=u.reg_read(UC_X86_REG_ESP);ret,y=struct.unpack('<II',u.mem_read(sp,8))
  u.reg_write(UC_X86_REG_EAX,366 if calendar.isleap(y) else 365)
  u.reg_write(UC_X86_REG_ESP,sp+8);u.reg_write(UC_X86_REG_EIP,ret)
u.hook_add(UC_HOOK_CODE,hook)
u.reg_write(UC_X86_REG_ECX,obj);u.reg_write(UC_X86_REG_ESP,stack+0xff00);u.mem_write(stack+0xff00,struct.pack('<I',stop))
u.emu_start(0x40a0e0,stop,count=2000000)
assert u.reg_read(UC_X86_REG_EIP)==stop
raw=bytes(u.mem_read(obj+0xbe0,7305))
fixture={'source':'Casio WQV Link 3.0 PCLink3.exe','sourceSHA256':hashlib.sha256(binary).hexdigest(),'encoderVA':'0040A0E0','method':'Original x86 encoder executed in Unicorn. Helper 00409FB0 stubbed with Gregorian year length. Unused UI days filled with DEADBEEF.','colourTableVA':'0040A8E4','colourTable':['standard','blue','red','green'],'dates':samples,'dataHex':raw.hex()}
f=args.output;f.write_text(json.dumps(fixture,indent=2)+'\n');print(f,hashlib.sha256(raw).hexdigest())
