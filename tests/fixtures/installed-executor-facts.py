"""Read real PostgreSQL facts using the installed small executor and bundled Node."""
import hashlib,json,pathlib,sys
sys.dont_write_bytecode=True
P=pathlib.Path
installed=P(sys.argv[1]).resolve(strict=True);config=P(sys.argv[2]);data=P(sys.argv[3])
sys.path.insert(0,str(installed/'updater'))
from installer_config import executor_facts
from installer_executor_install import executor_package
from installer_host import Host
build=json.loads((installed/'build-info.json').read_text());identity=executor_package(installed/'updater',build['commit'])
values={'DSH_PHALANX_DATABASE_CONFIG_FILE':str(config),'DSH_PHALANX_DATA_ROOT':str(data)}
before=hashlib.sha256(config.read_bytes()).hexdigest();host=Host()
schemas=executor_facts(host,values,'schemas',source=str(installed),schemas=['dsh_phalanx'])
selection=executor_facts(host,values,'download-sources',source=str(installed))
assert schemas=={'schemas':[{'name':'dsh_phalanx','version':15}]}
assert selection=={'selection':None}
missing=data/'executor-unavailable-config.json';assert not missing.exists() and not missing.is_symlink()
assert executor_facts(host,{**values,'DSH_PHALANX_DATABASE_CONFIG_FILE':str(missing)},'schemas',source=str(installed)) is None
assert executor_facts(host,values,'schemas',source=str(installed),schemas=['dsh_phalanx'])==schemas
assert hashlib.sha256(config.read_bytes()).hexdigest()==before
print(json.dumps({'status':'passed','source':build['commit'],'executorPackageSha256':identity['packageSha256'],'schemas':schemas['schemas'],'downloadSelection':None,'unavailableNotCached':True}))
