"""Release compatibility decisions through the installer reader seam."""
import copy
import unittest
import installer_compatibility as compatibility
from installer_compatibility import compatible,validate_contract,ReaderUpdateRequired

REVISION='687f282e8625c6b8d11ff58211a90524be2e4317'

def manifest(version):
    return {'schema':2,'targetVersion':version,'platform':'linux/amd64','dshRevision':REVISION,
            'compatibility':{'protocol':3,'source':{'min':'0.1.1','maxExclusive':version},
                             'accounts':{'sourceMin':7,'sourceMax':15,'target':15},'environmentEpoch':1},
            'storage':{'platformArchiveBytes':1,'platformExpandedBytes':1,'imageDownloadBytes':1,'imageExpandedBytes':1},
            'updater':'{}','acceptancePolicy':{'ticket':9,'checks':['ci','linux','upgrade','cleanInstall']}}

def target_manifest():
    target=manifest('0.1.28')
    target['compatibility'].update(protocol=9,source={'min':'0.1.26','maxExclusive':'0.1.28'},
        accounts={'sourceMin':15,'sourceMax':15,'target':15},minimumReader='0.1.27',upgradeFloor='0.1.26',breakpoints=[],
        schemas=[{'name':'dsh_phalanx','sourceMin':15,'sourceMax':15,'target':15}],futurePolicy={'ignored':True})
    target['channel']={'kind':'formal','futureTransport':{'ignored':True}}
    return target

class CompatibilityReader(unittest.TestCase):
    def test_supported_reader_accepts_future_protocol_and_unknown_properties(self):
        source=manifest('0.1.26');target=target_manifest()
        validate_contract(target)
        self.assertIsNone(compatible(source,target,15))

    def test_minimum_reader_is_checked_before_unknown_contract_content(self):
        target=target_manifest();target['compatibility']['minimumReader']='0.1.29'
        target['compatibility']['protocol']=999
        with self.assertRaises(ReaderUpdateRequired) as refused:validate_contract(target)
        self.assertEqual(refused.exception.required_version,'0.1.29')

    def test_registered_schema_ranges_allow_independent_recorded_versions(self):
        target=target_manifest();target['compatibility']['protocol']=3
        target['compatibility']['schemas'].append({'name':'isolated_probe','sourceMin':1,'sourceMax':2,'target':3})
        self.assertEqual(compatibility.upgrade_outcome(manifest('0.1.26'),target,{'dsh_phalanx':15,'isolated_probe':1}),
                         {'outcomeCode':'update.available'})

    def test_same_version_reports_current(self):
        target=target_manifest()
        self.assertEqual(compatibility.upgrade_outcome(manifest('0.1.28'),target,15),{'outcomeCode':'update.current'})

    def test_below_floor_returns_required_version_before_database_validation(self):
        self.assertEqual(compatibility.upgrade_outcome(manifest('0.1.25'),target_manifest(),None),
                         {'outcomeCode':'update.below-floor','requiredVersion':'0.1.26'})

    def test_breakpoint_is_a_reachable_first_hop_and_then_latest_is_available(self):
        source=manifest('0.1.26');target=target_manifest()
        target['compatibility'].update(environmentEpoch=2,breakpoints=[{'version':'0.1.27','environmentEpoch':2}])
        self.assertEqual(compatibility.upgrade_outcome(source,target,15),
                         {'outcomeCode':'update.breakpoint-required','requiredVersion':'0.1.27'})
        intermediate=copy.deepcopy(target);intermediate['targetVersion']='0.1.27'
        self.assertEqual(compatibility.upgrade_outcome(source,intermediate,15),{'outcomeCode':'update.available'})
        self.assertEqual(compatibility.upgrade_outcome(intermediate,target,15),{'outcomeCode':'update.available'})

    def test_same_version_candidate_can_enter_formal_channel(self):
        source=manifest('0.1.28');source['channel']={'kind':'candidate','futureSource':True}
        target=target_manifest()
        self.assertEqual(compatibility.upgrade_outcome(source,target,15),{'outcomeCode':'update.channel-switch'})
        compatible(source,target,15)

    def test_invalid_registry_and_unordered_breakpoints_are_rejected(self):
        for change in ({'schemas':[]},{'schemas':[{'name':'public','sourceMin':0,'sourceMax':0,'target':1}]},
                       {'schemas':[{'name':'dsh_phalanx','sourceMin':16,'sourceMax':15,'target':15}]},
                       {'upgradeFloor':'0.2.0'},
                       {'breakpoints':[{'version':'0.1.27','environmentEpoch':2},{'version':'0.1.26','environmentEpoch':1}]}):
            with self.subTest(change=change):
                target=target_manifest();target['compatibility'].update(change)
                with self.assertRaises(compatibility.InstallError):validate_contract(target)

    def test_check_reports_reader_update_as_a_structured_conclusion(self):
        target=target_manifest();target['compatibility']['minimumReader']='0.1.29'
        self.assertEqual(compatibility.upgrade_outcome(manifest('0.1.26'),target,None),
                         {'outcomeCode':'update.reader-update-required','requiredVersion':'0.1.29'})

    def test_release_tooling_uses_the_shared_installer_samples(self):
        import subprocess
        result=subprocess.run(['python3','scripts/release/check-compatibility.py'],input='',text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_original_v026_reader_accepts_this_releases_materialized_contract(self):
        import runpy
        from release_policy_support import release_policy
        from pathlib import Path
        policy=release_policy();target=manifest('0.1.27');target.update(policy)
        # Exact upstream tag v0.1.26 (a9a5f710); keep the predecessor validator unchanged.
        import hashlib
        self.assertEqual(hashlib.sha256(Path(__file__).with_name('compatibility-v026.py').read_bytes()).hexdigest(),
                         'a362f88ad93a150c9155e1e24f75d67f517ceda205a9a2b9c15c7177ee201933')
        old=runpy.run_path(str(Path(__file__).with_name('compatibility-v026.py')))
        old['validate_contract'](target)

    def test_stable_version_listing_uses_release_assets_without_api_access(self):
        import json
        from installer_release import release_versions
        class Host:
            def request(self,url,**kwargs):
                assert url=='https://github.com/dake6767/dsh-phalanx/releases/download/v0.1.28/release.json'
                return json.dumps({'version':'0.1.28','versions':['v0.1.25','v0.1.26','v0.1.27','v0.1.28']}).encode()
        self.assertEqual(release_versions(Host(),'0.1.26','v0.1.28'),['v0.1.26','v0.1.27','v0.1.28'])

    def test_a_source_newer_than_latest_is_already_current_and_cannot_downgrade(self):
        source=manifest('0.1.29');target=target_manifest()
        self.assertEqual(compatibility.upgrade_outcome(source,target,None),{'outcomeCode':'update.current'})
        with self.assertRaises(compatibility.InstallError) as refused:compatible(source,target,15)
        self.assertEqual(refused.exception.code,'compatibility.unsupported')

if __name__=='__main__':unittest.main()
