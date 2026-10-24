/** Configured Python variables are readable by name, without becoming native process environment bytes. */
export const pythonStartupEnvironmentNames = ['PATH', 'HOME', 'TMPDIR', 'PYTHONNOUSERSITE'] as const
export const privatePythonBootstrap = `import collections.abc,json,os,runpy,sys
with os.fdopen(3) as source:
    private = {key: value for key, value in json.load(source).items() if key not in ${JSON.stringify(pythonStartupEnvironmentNames)}}
class PrivateEnvironment(collections.abc.MutableMapping):
    def __init__(self, base, private):
        self.base, self.private = dict(base), private
    def __getitem__(self, key):
        return self.private[key] if key in self.private else self.base[key]
    def __setitem__(self, key, value):
        (self.private if key in self.private else self.base)[key] = value
    def __delitem__(self, key):
        del (self.private if key in self.private else self.base)[key]
    def __iter__(self):
        return (key for key in self.base if key not in self.private)
    def __len__(self):
        return sum(1 for key in self)
    def copy(self):
        return {key: self.base[key] for key in self}
os.environ = PrivateEnvironment(os.environ, private)
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(sys.argv[0]))
runpy.run_path(sys.argv[0], run_name='__main__')
`
export function pythonExecutionLaunch(command: string, argv: readonly string[], environment: Readonly<Record<string, string>>, script?: string) {
  return script ? { command, argv: ['-I', '-c', privatePythonBootstrap, script, ...argv],
    environment: Object.fromEntries(pythonStartupEnvironmentNames.filter(name => environment[name] !== undefined).map(name => [name, environment[name]!])), privateEnvironment: environment }
    : { command, argv, environment }
}
