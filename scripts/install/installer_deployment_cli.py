"""Public root deployment management command; host effects stay behind Host."""
import argparse
import json
import re
import sys
from installer_host import Host, InstallError
from installer_deployment import Deployment
from installer_progress import Progress, operator_text
from installer_questions import InstallerQuestions, Cancelled
from installer_uninstall import uninstall_command

PROJECT='https://github.com/dake6767/dsh-phalanx'
STATES={
    'not-installed':('未安装','Not installed'),'running':('运行中','Running'),'stopped':('已停止','Stopped'),
    'partial':('部分残留或尚未完成','Partial or residual'),'maintenance':('维护中，需先完成或恢复现有操作','Maintenance; complete or recover the existing operation'),
    'query-failed':('状态查询失败','Status query failed'),'idle':('空闲，无运行进程','Idle, no running process'),
    'unknown':('无法观察','Unknown'),'residual':('存在残留','Residual'),
}
COMPONENTS={'platform':('平台','Platform'),'updater':('升级执行器','Update executor'),'builtin-database':('内置数据库','Built-in database'),
            'maintenance-fence':('维护防护','Maintenance fence'),'maintenance-workers':('维护任务','Maintenance workers'),
            'builtin-database-containers':('内置数据库容器','Built-in database containers'),'upgrade-tools':('升级工具','Upgrade tools'),'members':('成员实例','Member instances')}


def reason_text(value,language):
    if language!='zh-CN':return value
    known={
        'Use sudo on the installed Linux host':'请在已安装的 Linux 主机上使用 sudo。',
        'Install the deployment before starting it':'请先完成安装，再启动部署。',
        'stop interrupts tasks; pass --yes to explicitly accept interruption':'停止会中断任务；请使用 --yes 明确接受中断。',
        'Another installation or maintenance operation owns the deployment lock':'已有安装或维护操作持有部署锁；请先完成该操作。',
        'Complete or recover the existing maintenance operation first':'请先完成或恢复现有维护操作。',
        'Incomplete installation; preserve configuration and retry installation':'安装尚未完成；请保留配置并重试安装。',
        'Cannot verify independent maintenance unit ownership':'无法核实独立维护单元的归属，未操作该单元。',
        'Member container ownership is inconsistent':'成员容器归属不一致，未操作无法核实的容器。',
        'Active service has no observable control group':'无法观察运行服务的控制组。',
        'Active service control group is unavailable':'运行服务的控制组不可用。',
    }
    if value in known:return known[value]
    query=re.fullmatch('Cannot observe managed (.*) service',value)
    if query:return '无法查询受管服务：'+query[1]
    pending=re.fullmatch('Some managed components have not reached (stopped|running); inspect component results and retry',value)
    if pending:return '部分组件尚未'+('停止' if pending[1]=='stopped' else '运行')+'；请查看分项结果，修正条件后重试。'
    return operator_text(value,language)


def render(result,args):
    if args.output=='json':
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return
    language=args.language
    index=0 if language=='zh-CN' else 1
    label=STATES.get(result['state'],(result['state'],result['state']))[index]
    if result['status']=='cancelled':label='已取消' if index==0 else 'Cancelled'
    print('dsh-phalanx · '+label+'\n')
    for row in result['components']:
        name=COMPONENTS.get(row['name'],(row['name'],row['name']))[index]
        state=STATES.get(row['state'],(row['state'],row['state']))[index]
        if row.get('initializationRequired'):state+=('（待初始化）' if index==0 else ' (initialization required)')
        print(name+'：'+state if index==0 else name+': '+state)
    if args.command in ('start','stop'):
        print('\n'+('数据及原开机自启设置保留；已中断的任务不会自动续跑。' if index==0 else 'Data and original autostart settings are retained. Interrupted tasks do not resume automatically.'))
    if result['errors']:
        print('\n'+('未完成或无法确认：' if index==0 else 'Incomplete or unconfirmed:'))
        for row in result['errors']:
            print('  '+COMPONENTS.get(row['component'],(row['component'],row['component']))[index]+': '+reason_text(row['reason'],language))


def main(arguments=None,host=None):
    arguments=list(sys.argv[1:] if arguments is None else arguments)
    class Parser(argparse.ArgumentParser):
        def error(self,message):raise InstallError(message)
    parser=Parser(add_help=False)
    parser.add_argument('command',nargs='?',choices=('start','stop','status','uninstall'))
    parser.add_argument('--language',choices=('zh-CN','en'),default='zh-CN')
    parser.add_argument('--output',choices=('human','json'),default='human')
    parser.add_argument('--yes',action='store_true')
    parser.add_argument('--purge',action='store_true')
    parser.add_argument('--help','-h',action='store_true')
    try:
        args=parser.parse_args(arguments)
        if args.purge and args.command!='uninstall':raise InstallError('--purge requires uninstall')
    except InstallError as error:
        output='json' if '--output=json' in arguments or any(arguments[i:i+2]==['--output','json'] for i in range(len(arguments))) else 'human'
        result={'schema':1,'status':'failed','state':'query-failed','errors':[{'component':'arguments','reason':str(error)}],'components':[],'changed':False}
        if output=='json':print(json.dumps(result))
        else:print('参数无效 / Invalid arguments: '+str(error))
        return 1
    if args.help or args.command is None:
        if args.output=='json':
            print(json.dumps({'schema':1,'status':'help','commands':['start','stop','status','uninstall'],'usage':'sudo dsh-phalanx start|stop|status|uninstall [--language zh-CN|en] [--output human|json] [--yes] [--purge]','stopRequiresConfirmation':True,'project':PROJECT}))
        else:
            print('dsh-phalanx — '+('部署管理' if args.language=='zh-CN' else 'Deployment management'))
            print('sudo dsh-phalanx start|stop|status|uninstall [--language zh-CN|en] [--output human|json] [--yes] [--purge]')
            print('stop 会中断任务，保留数据及原自启设置；start 不会续跑中断任务。' if args.language=='zh-CN' else 'stop interrupts tasks and retains data and autostart settings; start does not resume interrupted tasks.')
            print('uninstall 默认保留数据；--purge 清理核验归属的本地数据。' if args.language=='zh-CN' else 'uninstall retains data by default; --purge removes verified local deployment data.')
            print(PROJECT)
        return 0
    host=host or Host()
    if args.command=='uninstall':return uninstall_command(host,args)
    deployment=Deployment(host)
    def change(action,*,confirmed=True):
        report=Progress(host.root,output=args.output,persist=False,language=args.language)
        host.progress=report
        class Incomplete(InstallError):pass
        result=None
        try:
            with report.stage('Starting the deployment' if action=='start' else 'Stopping the deployment',phase_code='deployment.'+action):
                result=deployment.change(action,confirmed=confirmed)
                if result['errors']:raise Incomplete('Deployment operation is incomplete',code='service.'+action+'-failed')
        except Incomplete:pass
        finally:host.progress=None
        return result
    try:
        if host.uid!=0 or host.system!='Linux':
            result={'state':'query-failed','components':[],'errors':[{'component':'host','reason':'Use sudo on the installed Linux host'}]}
        elif args.command=='stop' and not args.yes:
            result=deployment.change('stop',confirmed=False)
            if result.get('confirmationRequired') and args.output=='human' and host.terminal_available():
                question=InstallerQuestions(args.language,host.prompt,host.operator,{})
                try:
                    answer=question.ask('输入 yes 确认停止全部任务；cancel 取消','Type yes to confirm stopping all tasks; cancel to cancel','cancel')
                    if answer=='yes':result=change('stop',confirmed=True)
                    else:result={**deployment.inspect(),'cancelled':True,'changed':False}
                except Cancelled:result={**deployment.inspect(),'cancelled':True,'changed':False}
        else:result=deployment.inspect() if args.command=='status' else change(args.command)
    except (OSError,ValueError,KeyError,TypeError,InstallError) as error:
        result={'state':'query-failed','components':[],'errors':[{'component':'deployment','reason':str(error)}]}
    status='cancelled' if result.get('cancelled') else 'failed' if result['errors'] or result['state'] in ('query-failed','partial') else 'succeeded'
    result={'schema':1,'command':args.command,'phaseCode':'deployment.'+args.command,'status':status,'changed':False,**result}
    # Preserve structured facts while withholding credentials or untrusted terminal controls from diagnostics.
    safe=Progress(host.root,persist=False,language=args.language).safe
    for row in result['errors']:row['reason']=safe(row['reason'])
    render(result,args)
    return 1 if result['status']=='failed' else 0


if __name__=='__main__':raise SystemExit(main())
