"""Harness activation retains new tests and dependencies plus exact bundle UI bytes."""
import io
from pathlib import Path
import runpy
import tarfile
import tempfile

module = runpy.run_path('scripts/dev/guest.py')
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    source, stage = root / 'source', root / 'snapshot'
    for path, content in [(source / 'node_modules/dependency', 'kept'), (source / 'admin-ui/dist/community.html', 'stale'),
                          (stage / 'tests/current.e2e.ts', 'new Harness')]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    archive = root / 'platform.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for name, content in [('dist/composition/cli.js', b'accepted CLI'), ('admin-ui/dist/community.html', b'accepted UI'), ('node/bin/node', b'excluded runtime')]:
            info = tarfile.TarInfo('./' + name)
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))
    module['activate_snapshot'].__globals__['SOURCE'] = source
    module['activate_snapshot'](stage)
    module['restore_build_assets'](archive)
    assert (source / 'admin-ui/dist/community.html').read_bytes() == b'accepted UI'
    assert (source / 'dist/composition/cli.js').read_bytes() == b'accepted CLI'
    assert (source / 'tests/current.e2e.ts').read_text() == 'new Harness'
    assert (source / 'node_modules/dependency').read_text() == 'kept'
    assert not (source / 'node').exists()
