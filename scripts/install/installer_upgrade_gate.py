"""Narrow root-only readiness admission, including legacy binaries and reboot."""
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

TABLE='dsh_phalanx_upgrade'
COMMENT='dsh-phalanx upgrade admission protocol 1'
MARK=0x44534850
MARKER='/etc/dsh-phalanx/maintenance'


class AdmissionGateError(Exception):pass


class LinuxAdmissionGate:
    def run(self,args,**kwargs):
        result=subprocess.run(['nft',*args],capture_output=True,text=True,**kwargs)
        if result.returncode!=0:raise AdmissionGateError('Scoped upgrade admission could not be configured (nft exit '+str(result.returncode)+')')
        return result.stdout

    def table_exists(self):
        tables=json.loads(self.run(['-j','list','tables']))['nftables']
        found=any(row.get('table',{}).get('family')=='inet' and row['table'].get('name')==TABLE for row in tables)
        if found:
            rows=json.loads(self.run(['-j','list','table','inet',TABLE]))['nftables']
            if not any(row.get('table',{}).get('comment')==COMMENT for row in rows):
                raise AdmissionGateError('The reserved upgrade admission table is owned by another configuration')
        return found

    def rules(self,ports,existing):
        if not isinstance(ports,list) or len(ports)!=2:raise AdmissionGateError('Invalid protected admission inventory')
        selectors=[]
        for endpoint in ports:
            if not isinstance(endpoint,dict) or type(endpoint.get('port')) is not int or not 1<=endpoint['port']<=65535:
                raise AdmissionGateError('Invalid protected admission port')
            address=ipaddress.ip_address(endpoint['address'])
            family='ip' if address.version==4 else 'ip6'
            destination=('meta nfproto ipv4' if address.version==4 else 'meta nfproto ipv6') if address.is_unspecified else family+' daddr '+str(address)
            selectors.append(destination+' tcp dport '+str(endpoint['port']))
            # A wildcard IPv6 listener can accept mapped IPv4 sockets.
            if address.version==6 and address.is_unspecified:selectors.append('meta nfproto ipv4 tcp dport '+str(endpoint['port']))
        outgoing='\n'.join('  '+selected+' meta mark '+str(MARK)+' ct mark set '+str(MARK) for selected in selectors)
        incoming='\n'.join('  '+selected+' ct mark != '+str(MARK)+' counter reject with tcp reset' for selected in selectors)
        return (('delete table inet '+TABLE+'\n') if existing else '')+f'''table inet {TABLE} {{
 comment "{COMMENT}"
 chain readiness {{
  type filter hook output priority -150; policy accept;
{outgoing}
 }}
 chain work_admission {{
  type filter hook input priority -150; policy accept;
{incoming}
 }}
}}
'''

    def batch(self,text,check=False):
        with tempfile.NamedTemporaryFile(mode='w',prefix='dsh-phalanx-admission-',delete=True) as file:
            os.fchmod(file.fileno(),0o600); file.write(text); file.flush()
            self.run((['--check'] if check else [])+['-f',file.name])

    def preflight(self,ports):self.batch(self.rules(ports,self.table_exists()),check=True)
    def close(self,ports):self.batch(self.rules(ports,self.table_exists()))
    def open(self):
        if self.table_exists():self.batch('delete table inet '+TABLE+'\n')

    def install(self,host,uid):
        program=globals().get('UPGRADE_GATE_SOURCE')
        if program is None:program=Path(__file__).read_text()
        host.atomic('/opt/dsh-phalanx/maintenance/gate.py',program,0o644)
        unit='[Unit]\nDescription=dsh-phalanx upgrade admission\nBefore=user@'+str(uid)+'.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/python3 /opt/dsh-phalanx/maintenance/gate.py\n'
        host.atomic('/etc/systemd/system/dsh-phalanx-maintenance.service',unit,0o644)
        host.atomic('/etc/systemd/system/user@'+str(uid)+'.service.d/dsh-phalanx-maintenance.conf',
                    '[Unit]\nRequires=dsh-phalanx-maintenance.service\nAfter=dsh-phalanx-maintenance.service\n',0o644)
        host.run(['systemctl','daemon-reload'])
        host.run(['systemctl','start','dsh-phalanx-maintenance.service'])


def protected_json(path):
    info=path.lstat()
    if path.is_symlink() or info.st_uid!=0 or info.st_mode & 0o022:raise AdmissionGateError('Invalid persistent admission carrier')
    return json.loads(path.read_text())


def restore_boot_admission():
    path=Path(MARKER); gate=LinuxAdmissionGate()
    if path.exists():
        value=protected_json(path)
        if value.get('schema')!=1:raise AdmissionGateError('Unknown persistent maintenance admission protocol')
        gate.close(value['ports']); return
    # The journal precedes the marker and all stop/switch effects. A crash in
    # that window must still restore admission before the managed user starts.
    root=Path('/var/lib/dsh-phalanx-updater'); pointer=root/'current'
    if pointer.exists():
        for carrier in (root,pointer):
            info=carrier.lstat()
            if carrier.is_symlink() or info.st_uid!=0 or info.st_mode & 0o022:raise AdmissionGateError('Invalid admission journal owner')
        operation=pointer.read_text().strip()
        if str(uuid.UUID(operation))!=operation:raise AdmissionGateError('Invalid admission operation identity')
        directory=root/operation
        info=directory.lstat()
        if directory.is_symlink() or info.st_uid!=0 or info.st_mode & 0o077:raise AdmissionGateError('Invalid admission operation owner')
        job=protected_json(directory/'operation.json')
        if job['phase'] in ('stopping','backing-up','backed-up','switching','validating','restoring','committed','restoration-committed','recovery-failed'):
            values=job['source']['values']
            gate.close([{'address':values['DSH_PHALANX_HOST'],'port':int(values['DSH_PHALANX_PORT'])},
                        {'address':'127.0.0.1','port':int(values.get('DSH_PHALANX_CONTAINER_GATEWAY_PORT','3081'))}]); return
        if job['phase'] not in ('preparing','prepared','prepare-failed','apply-failed','succeeded','restored'):
            raise AdmissionGateError('Unknown admission operation phase')
    gate.open()


if __name__=='__main__' and Path(sys.argv[0]).name=='gate.py':
    try:restore_boot_admission()
    except Exception:
        print('Upgrade admission could not be restored; the managed user service must remain stopped.',file=sys.stderr)
        sys.exit(1)
