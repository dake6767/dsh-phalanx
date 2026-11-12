"""Guard the privileged acceptance fixture before it can stop or copy any deployment."""
import copy
from pathlib import Path
import runpy
import unittest

require=runpy.run_path(str(Path(__file__).with_name('deployment-host.py')))['require_unused_baseline']


class LifecycleOwnership(unittest.TestCase):
    def facts(self):
        source={'values':{'DSH_PHALANX_DATA_ROOT':'/var/lib/dsh-phalanx/data','DSH_PHALANX_DATABASE_CONFIG_FILE':'/var/lib/dsh-phalanx/keys/database.json'}}
        state={'state':'running','databaseSelection':None,'errors':[],'operations':[],'components':[{'name':'members','total':0},{'name':'maintenance-workers','running':0},{'name':'upgrade-tools','running':0}]}
        return source,state

    def test_an_unused_verified_default_baseline_can_be_borrowed_without_mutating_the_guard_inputs(self):
        source,state=self.facts();before=copy.deepcopy((source,state))
        require(source,state)
        self.assertEqual((source,state),before)
        state['state']='stopped';require(source,state)

    def test_initialized_busy_unobservable_and_foreign_storage_baselines_are_never_borrowed(self):
        for case in ('builtin','external','member','maintenance','tools','operation','unknown','query-failure','platform-path','user-path','mount'):
            with self.subTest(case=case):
                source,state=self.facts()
                if case in ('builtin','external'):state['databaseSelection']=case
                elif case=='member':state['components'][0]['total']=1
                elif case=='maintenance':state['components'][1]['running']=1
                elif case=='tools':state['components'][2]['running']=1
                elif case=='operation':state['operations']=[{'phase':'prepared'}]
                elif case=='unknown':state['state']='partial'
                elif case=='query-failure':state['errors']=[{'component':'database'}]
                elif case=='platform-path':source['values']['DSH_PHALANX_DATA_ROOT']='/foreign/data'
                elif case=='user-path':source['values']['DSH_PHALANX_USER_DATA_ROOT']='/foreign/users'
                else:source['values']['DSH_PHALANX_USER_DATA_MOUNT']='/foreign'
                with self.assertRaises(ValueError):require(source,state)


if __name__=='__main__':unittest.main()
