"""Same-version candidate rehearsal is explicit and cannot weaken real upgrades."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from installer_contract_support import installer,with_image_identity
UpgradeMachine=runpy.run_path(str(Path(__file__).with_name('upgrade-machine.py')))['UpgradeMachine']
GATE=type('Gate',(),{'preflight':lambda self,ports:None,'install':lambda self,host,uid:None,'close':lambda self,ports:None,'open':lambda self:None})

class Rehearsal(unittest.TestCase):
    def test_only_explicit_same_image_same_schema_candidate_rehearsals_can_prepare(self):
        for fault in (None,'implicit','source-formal','target-formal','unmarked','image','epoch','schema','downgrade'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory,patch('installer_upgrade_host.LinuxAdmissionGate',GATE),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                machine=UpgradeMachine(directory);machine.database_schema=5
                def command(args,**kwargs):
                    if 'podman' in args and args[-3:]==['info','--format','json']:
                        return subprocess.CompletedProcess(args,0,json.dumps({'host':{'security':{'rootless':True},'cgroupVersion':'v2'},'store':{'graphRoot':'/images','imageCopyTmpDir':'/image-tmp'}}),'')
                    return machine.command(args,**kwargs)
                host=installer.Host(machine.root,command,system='Linux',machine='x86_64',uid=0);host.request=lambda *a,**k:b'login' 
                def bundle(number,commit):
                    args=machine.make_bundle('v0.1.17-rc.'+str(number),commit);m=with_image_identity(machine,args)
                    m.update(schema=2,tag='run-'+str(number),runId=str(number),compatibility={'protocol':3,'source':{'min':'0.1.16','maxExclusive':'0.1.17'},'accounts':{'sourceMin':5,'sourceMax':5,'target':5},'environmentEpoch':1},acceptancePolicy={'ticket':8,'checks':['ci','linux','cleanInstall','upgrade','review']},storage={key:1 for key in ('platformArchiveBytes','platformExpandedBytes','imageDownloadBytes','imageExpandedBytes')},updater='{}',imageSelection={'rehearsal':True})
                    m['image']['tag']=m['tag'];args[1]=m['tag'];(Path(args[3])/'manifest.json').write_text(json.dumps(m));return args,m
                args,source=bundle(101,'a');self.assertEqual(installer.main(args,host),0)
                data=machine.root/'var/lib/dsh-phalanx/data';data.mkdir()
                with sqlite3.connect(data/'community-accounts.db') as connection:connection.execute('PRAGMA user_version=5')
                args,target=bundle(102,'d')
                if fault=='source-formal':
                    p=machine.root/'etc/dsh-phalanx/install-state.json';v=json.loads(p.read_text());v['version']='v0.1.17';p.write_text(json.dumps(v))
                elif fault=='target-formal':args[1]='v0.1.17'
                elif fault=='unmarked':target['imageSelection']['rehearsal']=False
                elif fault=='image':target['imageIdentity']['inputHash']='0'*64
                elif fault=='epoch':target['compatibility']['environmentEpoch']=2
                elif fault=='schema':target['compatibility']['accounts']['target']=6
                elif fault=='downgrade':target['targetVersion']='0.1.16';target['compatibility']['source']={'min':'0.1.15','maxExclusive':'0.1.16'}
                (Path(args[3])/'manifest.json').write_text(json.dumps(target))
                flags=[] if fault=='implicit' else ['--dev-image-reuse-rehearsal']
                with contextlib.redirect_stdout(output:=io.StringIO()):status=installer.main([*args,*flags,'--upgrade','prepare','--output','json'],host)
                self.assertEqual(status,0 if fault is None else 1,output.getvalue())
                if fault is None:
                    operation=json.loads(output.getvalue())['operation']['id']
                    with contextlib.redirect_stdout(output:=io.StringIO()):
                        status=installer.main(['--upgrade','apply','--operation',operation,'--yes','--dev-image-reuse-rehearsal','--output','json'],host)
                    self.assertEqual(status,0,output.getvalue())
                    self.assertEqual(json.loads(output.getvalue())['operation']['phase'],'succeeded')

if __name__=='__main__':unittest.main()
