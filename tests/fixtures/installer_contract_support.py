"""Share the existing installation machine at its external OS seam."""
import runpy
from pathlib import Path
_contract = runpy.run_path(str(Path(__file__).with_name('installer-contract.py')))
installer = _contract['installer']
InstallationMachine = _contract['InstallationMachine']


def with_image_identity(machine,args):
    """Prepare a public bundle whose independent image was built by another commit."""
    import json
    path=Path(args[3])/'manifest.json';manifest=json.loads(path.read_text())
    manifest['imageIdentity']={'inputHash':'f'*64,'dshRevision':manifest['dshRevision'],
        'digest':manifest['image']['digest'],'buildCommit':'e'*40}
    path.write_text(json.dumps(manifest))
    machine.image_facts['Config']['Labels'].update({'dsh.input.sha256':'f'*64,'org.opencontainers.image.revision':'e'*40})
    return manifest
