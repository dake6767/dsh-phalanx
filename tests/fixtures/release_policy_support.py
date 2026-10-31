"""Test-only policy materialization from the actual source composition registry."""
import json
import subprocess

def release_policy():
    code="""
import fs from 'node:fs';
import { releaseCompatibility } from './scripts/release/schema-contract.mjs';
import { PLATFORM_SCHEMAS, registeredSchemas } from './src/adapters/platform-schema-registry.ts';
const policy=JSON.parse(fs.readFileSync('release-policy.json','utf8'));
policy.compatibility=releaseCompatibility(policy.compatibility,registeredSchemas(PLATFORM_SCHEMAS).map(s=>({name:s.name,target:s.migrations.at(-1).version})));
console.log(JSON.stringify(policy));
"""
    return json.loads(subprocess.check_output(['node','--import','tsx','--input-type=module','-e',code],text=True))
