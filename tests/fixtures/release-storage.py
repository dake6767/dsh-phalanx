"""Build-derived capacity facts include expanded layers, not compressed sizes."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
storage=runpy.run_path(str(Path(__file__).resolve().parents[2]/'scripts/release/storage.py'))['release_storage']

def tar_bytes(files,compressed=False):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz' if compressed else 'w') as archive:
        for name,value in files.items():
            entry=tarfile.TarInfo(name);entry.size=len(value);archive.addfile(entry,io.BytesIO(value))
    return stream.getvalue()

class Storage(unittest.TestCase):
    def test_measures_filesystem_allocation_and_keeps_exact_updater_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);raw='{"schema":1,"files":{}}\n'
            (root/'dsh-phalanx-linux-amd64.tar.gz').write_bytes(tar_bytes({'updater/manifest.json':raw.encode(),'node/bin/node':bytes(100_000)},True))
            layer=gzip.compress(tar_bytes({'large-sparse-input':bytes(500_000)}));layer_hash=hashlib.sha256(layer).hexdigest()
            config=json.dumps({'rootfs':{'diff_ids':['sha256:'+'a'*64]}}).encode();config_hash=hashlib.sha256(config).hexdigest()
            manifest=json.dumps({'config':{'digest':'sha256:'+config_hash},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':'sha256:'+layer_hash,'size':len(layer)}]}).encode();manifest_hash=hashlib.sha256(manifest).hexdigest()
            image=tar_bytes({'blobs/sha256/'+config_hash:config,'index.json':json.dumps({'manifests':[{'digest':'sha256:'+manifest_hash}]}).encode(),'blobs/sha256/'+manifest_hash:manifest,'blobs/sha256/'+layer_hash:layer})
            (root/'dsh-phalanx-dsh-linux-amd64.oci.tar').write_bytes(image)
            result=storage(root)
            self.assertEqual(result['updater'],raw)
            self.assertEqual(result['storage']['imageDownloadBytes'],len(image))
            self.assertGreater(result['storage']['platformExpandedBytes'],100_000)
            self.assertGreater(result['storage']['imageExpandedBytes'],1_000_000)

if __name__=='__main__':unittest.main()
