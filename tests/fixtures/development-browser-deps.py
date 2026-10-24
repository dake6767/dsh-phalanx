"""The browser dependency subprocess inherits a private apt lock-wait configuration."""
import os
from pathlib import Path
import runpy
import tempfile

module = runpy.run_path('scripts/validation/t2-host.py')
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary)
    calls = []
    def command(args, **options):
        calls.append(args)
        assert options['cwd'] == path
        config = Path(options['env']['APT_CONFIG'])
        assert config.parent == path
        assert config.read_text() == 'DPkg::Lock::Timeout "600";\n'
        assert config.stat().st_mode & 0o077 == 0
    function = module['browser_dependencies']
    function.__globals__['run'] = command
    before = os.environ.get('APT_CONFIG')
    function(path, path)
    assert calls == [['node','node_modules/playwright/cli.js','install-deps','chromium']]
    assert os.environ.get('APT_CONFIG') == before
