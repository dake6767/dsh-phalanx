"""A large guest receipt can be split by stderr on the SSH transport."""
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('linux_background',Path('scripts/dev/linux.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ReceiptTransport(unittest.TestCase):
    def test_interleaved_warning_uses_the_same_immutable_guest_receipt(self):
        receipt={'status':'passed','runId':'123','results':'/var/lib/dsh-phalanx-dev/t2-results/123','files':[{'file':'tests/example.e2e.ts','status':'passed'}],'padding':'a'*40000}
        encoded=json.dumps(receipt);raw=(json.dumps(receipt,indent=2)+'\n').encode();calls=[]
        warning='Report to the maintainer: guest disk usage exceeded approximately 27 GiB.'
        log='Linux acceptance receipt: '+encoded[:32736]+warning+'\n'+encoded[32736:]+'\n'
        def read(identity):calls.append(identity);return raw
        actual,transport=module.acceptance_receipt(log,read)
        self.assertEqual(actual,receipt);self.assertEqual(calls,['123'])
        self.assertEqual(transport['runId'],'123')
        self.assertEqual(transport['method'],'guest-canonical-summary')

    def test_complete_receipt_never_reads_a_different_guest_file(self):
        def forbidden(_):raise AssertionError('A complete receipt needs no recovery')
        actual,transport=module.acceptance_receipt('Linux acceptance receipt: {"runId":"123","status":"passed"}\n',forbidden)
        self.assertEqual(actual['runId'],'123');self.assertIsNone(transport)

    def test_recovery_keeps_the_failed_host_record_and_never_starts_another_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);prior=root/'1-abcd';prior.mkdir()
            before=json.dumps({'status':'failed','exitCode':0,'elapsedSeconds':80,'error':'interleaved JSON'})
            (prior/'status.json').write_text(before)
            log='Linux acceptance receipt: {"runId":"123","files": [warning\n'
            (prior/'output.log').write_text(log)
            raw=json.dumps({'runId':'123','results':'/var/lib/dsh-phalanx-dev/t2-results/123','status':'passed','files':[]}).encode()
            stream=StringIO()
            with patch.object(module,'STATE',root),patch.object(module,'canonical_receipt',return_value=raw),patch.object(module.subprocess,'run',side_effect=AssertionError('No new guest case may run')),redirect_stdout(stream):
                module.recover_receipt('1-abcd')
            recovered=json.loads((root/json.loads(stream.getvalue())['runId']/'status.json').read_text())
            self.assertEqual(recovered['status'],'passed');self.assertEqual(recovered['recoveredFromHostRun'],'1-abcd')
            self.assertEqual((prior/'status.json').read_text(),before);self.assertEqual((prior/'output.log').read_text(),log)

    def test_recovery_rejects_a_canonical_receipt_from_another_run(self):
        log='Linux acceptance receipt: {"runId":"123","files": [warning\n'
        with self.assertRaisesRegex(ValueError,'does not match'):
            module.acceptance_receipt(log,lambda _:b'{"runId":"456","status":"passed"}')

if __name__=='__main__':unittest.main()
