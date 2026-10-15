"""Resolve synthetic registry DNS only inside the owned development VM."""
import ipaddress
import json
import os
from pathlib import Path
import socket
import tempfile
import urllib.request
from urllib.parse import urlsplit

BEGIN = '# BEGIN dsh-phalanx development registry DNS\n'
END = '# END dsh-phalanx development registry DNS\n'
REGISTRIES = {'registry.npmjs.org': ('registry.npmjs.org',),
              'registry.npmmirror.com': ('registry.npmmirror.com', 'cdn.npmmirror.com')}


def registry_dns(registry, hosts=Path('/etc/hosts')):
    if hosts.is_symlink() or not hosts.is_file(): raise ValueError('Development DNS requires a regular hosts file')
    content = hosts.read_text(); info = hosts.stat()
    def save(value):
        with tempfile.NamedTemporaryFile(mode='w', dir=hosts.parent, prefix='.dsh-registry-', delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(value); file.flush(); os.fsync(file.fileno())
                os.fchmod(file.fileno(), info.st_mode & 0o777); os.fchown(file.fileno(), info.st_uid, info.st_gid)
                os.replace(temporary, hosts)
            finally: temporary.unlink(missing_ok=True)
    repaired_names = set()
    if BEGIN in content or END in content:
        if content.count(BEGIN) != 1 or content.count(END) != 1 or content.index(BEGIN) > content.index(END):
            raise ValueError('Inspect the owned development DNS marker before retrying')
        before, after = content.split(BEGIN)
        managed, remainder = after.split(END, 1)
        repaired_names = {name for line in managed.splitlines() for name in line.split()[1:]}
        content = before + remainder
        save(content)
    rows = []
    for name in REGISTRIES.get(urlsplit(registry).hostname, ()):
        addresses = {ipaddress.ip_address(row[4][0]) for row in socket.getaddrinfo(name, 443)}
        # A resolver may retain the former hosts entry after removal. Refresh
        # previously repaired names through public DNS instead of treating that
        # cached answer as proof that synthetic DNS is gone.
        if name not in repaired_names and not any(address in ipaddress.ip_network('198.18.0.0/15') for address in addresses): continue
        request = urllib.request.Request('https://cloudflare-dns.com/dns-query?name='+name+'&type=A', headers={'accept': 'application/dns-json'})
        with urllib.request.urlopen(request, timeout=30) as response: answer = json.load(response)
        public = [ipaddress.ip_address(row['data']) for row in answer.get('Answer', []) if row.get('type') == 1]
        if answer.get('Status') != 0 or not public or len(public) > 16 or any(not value.is_global for value in public):
            raise ValueError('Cannot obtain public DNS for '+name+'; correct synthetic DNS before retrying the development VM')
        rows.extend(str(address)+' '+name+'\n' for address in public)
    if rows: save(content.rstrip('\n')+'\n'+BEGIN+''.join(rows)+END)
    return {'ownedRegistryEntries': len(rows), 'resolver': 'https://cloudflare-dns.com/dns-query' if rows else 'system', 'macDnsChanged': False}
