"""Exercise physical bytes and container-namespace links without a running installation."""
import base64,json,os,pathlib,sys,tempfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'scripts/validation'))
from secret_scan_files import secret_needles,scan_secret_file,runtime_projection_target
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary);secret=b'fixture-sensitive-platform-value';needles=secret_needles([('credential',secret)])
 assert len(needles)==4
 for index,body in enumerate((secret,secret.hex().encode(),base64.b64encode(secret),base64.urlsafe_b64encode(secret).rstrip(b'='))):
  p=root/str(index);p.write_bytes(b'x'*13+body+b'z'*19);count,found=scan_secret_file(p,needles,chunk_size=16)
  assert count==p.stat().st_size and found=={'credential'}
 safe=root/'safe';safe.write_bytes(b'no credentials');assert scan_secret_file(safe,needles,chunk_size=7)[1]==set()
 data=root/'data';tree=data/'runtime-dependencies/.trees'/('a'*64);binary=tree/'bin/officecli';binary.parent.mkdir(parents=True);binary.write_bytes(secret)
 link=data/'skills/members/space/dependencies/generation/officecli';link.parent.mkdir(parents=True);link.symlink_to('/dsh-phalanx/runtime-dependencies/.trees/'+'a'*64+'/bin/officecli')
 target=runtime_projection_target(link,data,os.getuid());assert target==binary.resolve(strict=True) and scan_secret_file(target,needles)[1]=={'credential'}
 rejected=0
 for change in ('missing','escape','ownership'):
  binary.unlink(missing_ok=True)
  if change=='escape':binary.symlink_to(safe)
  else:binary.write_bytes(secret)
  if change=='missing':binary.unlink()
  try:runtime_projection_target(link,data,os.getuid()+1 if change=='ownership' else os.getuid())
  except (ValueError,FileNotFoundError):rejected+=1
  else:raise AssertionError('Invalid runtime target accepted')
  if binary.exists() or binary.is_symlink():binary.unlink()
 assert rejected==3
 link.unlink();link.symlink_to('/etc/passwd');assert runtime_projection_target(link,data,os.getuid()) is None
 print(json.dumps({'representations':4,'crossChunkMatches':4,'cleanFile':True,'runtimeTargetScanned':True,'invalidTargetsRejected':rejected,'unknownAliasNotAccepted':True}))
