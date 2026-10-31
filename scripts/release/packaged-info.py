"""Read the bounded build identity from the exact platform archive."""
import json
import sys
import tarfile

with tarfile.open(sys.argv[1],'r:gz') as archive:
    entries=[entry for entry in archive.getmembers() if entry.name.removeprefix('./')=='build-info.json']
    if len(entries)!=1 or not entries[0].isfile() or entries[0].size>65536:
        raise ValueError('Packaged build inventory is missing or ambiguous')
    print(json.dumps(json.load(archive.extractfile(entries[0]))))
