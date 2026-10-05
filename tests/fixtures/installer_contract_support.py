"""Share the existing installation machine at its external OS seam."""
import runpy
from pathlib import Path
_contract = runpy.run_path(str(Path(__file__).with_name('installer-contract.py')))
installer = _contract['installer']
InstallationMachine = _contract['InstallationMachine']
