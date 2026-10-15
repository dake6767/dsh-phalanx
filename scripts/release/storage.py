"""Measure packaged writes without extracting trusted build inputs to disk."""
import gzip
import json
from pathlib import Path
import sys
import tarfile


def release_storage(directory,architecture='amd64'):
    if architecture not in ('amd64','arm64'):raise ValueError('Unsupported artifact architecture')
    directory=Path(directory)
    platform=directory/f'dsh-phalanx-linux-{architecture}.tar.gz';image=directory/f'dsh-phalanx-dsh-linux-{architecture}.oci.tar'
    with tarfile.open(platform,'r:gz') as archive:
        members=archive.getmembers()
        expanded=sum(((entry.size+4095)//4096)*4096+4096 for entry in members)
        inventories=[entry for entry in members if entry.name.removeprefix('./')=='updater/manifest.json']
        if len(inventories)!=1:raise ValueError('Platform updater inventory is missing or ambiguous')
        updater=archive.extractfile(inventories[0]).read(16385).decode()
        if len(updater.encode())>16384:raise ValueError('Updater inventory exceeds its bound')
    with tarfile.open(image) as archive:
        index=json.load(archive.extractfile('index.json'))
        descriptor=index['manifests'][0]
        manifest=json.load(archive.extractfile('blobs/sha256/'+descriptor['digest'].split(':')[1]))
        config=json.load(archive.extractfile('blobs/sha256/'+manifest['config']['digest'].split(':')[1]))
        diff_ids=config['rootfs']['diff_ids'];layers=[]
        if len(diff_ids)!=len(manifest['layers']):raise ValueError('Image layer/config inventory mismatch')
        expanded_image=0
        for layer,diff_id in zip(manifest['layers'],diff_ids):
            stream=archive.extractfile('blobs/sha256/'+layer['digest'].split(':')[1])
            if layer['mediaType'].endswith('+gzip'):stream=gzip.GzipFile(fileobj=stream)
            elif not layer['mediaType'].endswith('.tar'):raise ValueError('Unsupported image layer compression')
            with tarfile.open(fileobj=stream,mode='r|') as contents:
                size=sum(((entry.size+4095)//4096)*4096+4096 for entry in contents)
                expanded_image+=size
                layers.append({'diffId':diff_id,'downloadBytes':layer['size'],'expandedBytes':max(4096,size)})
    return {'storage':{'platformArchiveBytes':platform.stat().st_size,'platformExpandedBytes':expanded,
                       'imageDownloadBytes':image.stat().st_size,'imageExpandedBytes':max(4096,expanded_image)*2,'imageLayers':layers},'updater':updater}

if __name__=='__main__':print(json.dumps(release_storage(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else 'amd64')))
