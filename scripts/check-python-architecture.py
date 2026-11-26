#!/usr/bin/env python3
"""Zero-dependency static architecture and style gate for repository Python code."""
import argparse
import ast
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tokenize


def _load_ast_checks():
    module_path = Path(__file__).resolve().with_name('check-python-ast.py')
    spec = importlib.util.spec_from_file_location('check_python_ast', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AST_CHECKS = _load_ast_checks()
check_scope = _AST_CHECKS.check_scope
check_error_text_branches = _AST_CHECKS.check_error_text_branches

CODE_LINE_LIMIT = 500

LAYERS = {
    'L0': frozenset({'installer_upgrade_gate'}),
    'L1': frozenset({
        'installer_compatibility',
        'installer_questions',
        'installer_upgrade_core',
        'installer_executor_protocol',
    }),
    'L2': frozenset({
        'installer_host',
        'installer_config',
        'installer_progress',
        'installer_storage',
        'installer_release',
        'installer_upgrade_backup',
        'installer_executor_install',
        'installer_cleanup',
        'installer_database',
        'installer_upgrade_host',
        'installer_operations',
        'installer_deployment',
        'installer_uninstall',
        'installer_executor_bootstrap',
    }),
    'L3': frozenset({
        'installer_executor_server',
        'installer_executor',
        'installer_upgrade_cli',
        'installer_deployment_cli',
        'installer',
        'updater',
        'preview',
    }),
}
MODULE_LAYER = {name: layer for layer, names in LAYERS.items() for name in names}
ALLOWED_LAYER_IMPORTS = {
    'L0': frozenset(),
    'L1': frozenset({'L1'}),
    'L2': frozenset({'L0', 'L1', 'L2'}),
    'L3': frozenset({'L0', 'L1', 'L2', 'L3'}),
}
L1_FORBIDDEN_IMPORTS = frozenset({
    'asyncio', 'ctypes', 'fcntl', 'ftplib', 'glob', 'grp',
    'http', 'http.client', 'http.server', 'importlib', 'mmap', 'multiprocessing',
    'os', 'pathlib', 'pty', 'pwd', 'resource', 'runpy',
    'select', 'selectors', 'shutil', 'signal', 'smtplib', 'socket',
    'socketserver', 'sqlite3', 'ssl', 'subprocess', 'tempfile', 'termios',
    'urllib', 'urllib.error', 'urllib.request', 'webbrowser',
})
L1_FORBIDDEN_CALLS = frozenset({'open', '__import__'})

RESTRICTED_WORDING_RE = re.compile(
    '\u5546\u4e1a\u7248|\u4f01\u4e1a\u7248|\u79ef\u5206|\u8ba1\u8d39|\u4ed8\u8d39|\u6263\u8d39'
    '|\x63\x6f\x6d\x6d\x65\x72\x63\x69\x61\x6c\\s+edition|\x65\x6e\x74\x65\x72\x70\x72\x69\x73\x65\\s+edition',
    re.IGNORECASE,
)
INFRA_CHROMIUM_RE = re.compile(
    r'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST|browserChromiumArm64|chromium_arm64_download_host|chromium-arm64-download-host'
)
SUITE_IDENTITY_RE = re.compile(
    r'(?<![A-Za-z0-9_])(?:officecli|minimax|mmx|lark|larksuite|hyperframes|wecom|pandoc|ffmpeg|ffprobe|chromium)(?![A-Za-z0-9_])',
    re.IGNORECASE,
)

SKIP_COUNT_TOKENS = frozenset({
    tokenize.COMMENT,
    tokenize.NL,
    tokenize.NEWLINE,
    tokenize.INDENT,
    tokenize.DEDENT,
    tokenize.ENCODING,
    tokenize.ENDMARKER,
})
COMPOUND_NODES = tuple(
    cls
    for cls in (
        ast.If,
        ast.For,
        ast.AsyncFor,
        ast.While,
        ast.Try,
        getattr(ast, 'TryStar', None),
        ast.With,
        ast.AsyncWith,
        ast.FunctionDef,
        ast.AsyncFunctionDef,
        ast.ClassDef,
        getattr(ast, 'Match', None),
    )
    if cls is not None
)


def count_code_lines(source):
    lines = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type not in SKIP_COUNT_TOKENS and token.string.strip():
            for line_no in range(token.start[0], token.end[0] + 1):
                lines.add(line_no)
    return len(lines)


def check_no_inline_statements(rel, source, tree):
    errors = []
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    meaningful = []
    index_by_pos = {}
    for token in tokens:
        if token.type == tokenize.OP and token.string == ';':
            errors.append(f'{rel}:{token.start[0]}: semicolon statement separator is forbidden')
        if token.type not in (tokenize.COMMENT, tokenize.NL, tokenize.ENCODING):
            index_by_pos[token.start] = len(meaningful)
            meaningful.append(token)

    def check_suite(stmts, label, allow_elif=False):
        if not stmts:
            return
        first = stmts[0]
        pos = (first.lineno, first.col_offset)
        idx = index_by_pos.get(pos)
        if idx is None or idx == 0:
            return
        if allow_elif and isinstance(first, ast.If) and meaningful[idx].string == 'elif':
            return
        prev = meaningful[idx - 1]
        if prev.type == tokenize.OP and prev.string == ':' and prev.end[0] == first.lineno:
            errors.append(f'{rel}:{first.lineno}: inline compound statement ({label}) must be split across lines')

    for node in ast.walk(tree):
        if not isinstance(node, COMPOUND_NODES):
            continue
        label = type(node).__name__.lower()
        if hasattr(node, 'body'):
            check_suite(node.body, label)
        if hasattr(node, 'orelse') and node.orelse:
            check_suite(node.orelse, 'else', allow_elif=isinstance(node, ast.If))
        if hasattr(node, 'finalbody') and node.finalbody:
            check_suite(node.finalbody, 'finally')
        if hasattr(node, 'handlers'):
            for handler in node.handlers:
                check_suite(handler.body, 'except')
        if hasattr(node, 'cases'):
            for case in node.cases:
                check_suite(case.body, 'case')
    return errors


def _module_imports(tree):
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == 'urllib':
                for alias in node.names:
                    imports.append((node.lineno, f'urllib.{alias.name}'))
            else:
                imports.append((node.lineno, node.module))
    return imports


def check_layers_and_dag(product_trees):
    errors = []
    graph = {}
    for rel, tree in sorted(product_trees.items()):
        if rel == 'scripts/download-sources.py':
            module_name = 'download-sources'
            layer = 'L3'
        else:
            module_name = Path(rel).stem
            layer = MODULE_LAYER.get(module_name)
            if layer is None:
                errors.append(f'{rel}: unregistered scripts/install module has no architecture layer')
                continue
        graph.setdefault(module_name, set())
        if layer == 'L1':
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in L1_FORBIDDEN_CALLS:
                    errors.append(f"{rel}:{node.lineno}: L1 pure module cannot call '{node.func.id}'")
        for lineno, target in _module_imports(tree):
            top = target.split('.')[0]
            if layer == 'L1' and (target in L1_FORBIDDEN_IMPORTS or top in L1_FORBIDDEN_IMPORTS):
                if not target.startswith('urllib.parse'):
                    errors.append(f"{rel}:{lineno}: L1 pure module cannot import OS/network I/O module '{target}'")
            is_local = top in MODULE_LAYER or top.startswith('installer_') or top in ('updater', 'preview')
            if not is_local:
                continue
            target_layer = MODULE_LAYER.get(top)
            if layer == 'L0':
                errors.append(f"{rel}:{lineno}: L0 standalone module cannot import '{top}'")
            elif target_layer is None:
                errors.append(f"{rel}:{lineno}: import of unregistered installer module '{top}'")
            elif target_layer not in ALLOWED_LAYER_IMPORTS[layer]:
                errors.append(f"{rel}:{lineno}: {layer} module cannot import {target_layer} module '{top}'")
            else:
                graph[module_name].add(top)

    state = {}
    path = []
    reported_cycles = set()

    def dfs(node):
        state[node] = 1
        path.append(node)
        for dep in sorted(graph.get(node, ())):
            dep_state = state.get(dep, 0)
            if dep_state == 1:
                cycle = path[path.index(dep):] + [dep]
                key = tuple(cycle)
                if key not in reported_cycles:
                    reported_cycles.add(key)
                    errors.append(f"dependency cycle: {' -> '.join(cycle)}")
            elif dep_state == 0 and dep in graph:
                dfs(dep)
        path.pop()
        state[node] = 2

    for node in sorted(graph):
        if state.get(node, 0) == 0:
            dfs(node)
    return errors


def _parse_build_installer(build_path):
    text = build_path.read_text(encoding='utf-8')
    vars_match = re.search(r'const\s*\[\s*([\s\S]*?)\s*\]\s*=\s*await\s+Promise\.all\s*\(\s*\[([\s\S]*?)\]\s*\)', text)
    if not vars_match:
        return None, None, 'could not parse module bindings in scripts/install/build-installer.mjs'
    var_names = [item.strip() for item in vars_match.group(1).split(',') if item.strip()]
    file_names = re.findall(r"readFile\(\s*new\s+URL\(\s*'([^']+)'", vars_match.group(2))
    if len(var_names) != len(file_names):
        return None, None, 'mismatched module bindings and readFile entries in scripts/install/build-installer.mjs'
    var_to_file = dict(zip(var_names, file_names))
    for derived, base in re.findall(r'const\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\.replace\(', text):
        if base in var_to_file:
            var_to_file[derived] = var_to_file[base]
    array_match = re.search(r'\[\s*([^\[\]]*?)\s*\]\s*\.map\(\s*source\s*=>\s*source\.replace\(\s*/([^\n]+)/gmu', text)
    if not array_match:
        return None, None, 'could not parse concatenation order or strip pattern in scripts/install/build-installer.mjs'
    order_vars = [item.strip() for item in array_match.group(1).split(',') if item.strip()]
    ordered_files = []
    for var in order_vars:
        if var not in var_to_file:
            return None, None, f"unknown concatenation variable '{var}' in scripts/install/build-installer.mjs"
        ordered_files.append(var_to_file[var])
    strip_pattern = array_match.group(2).replace(r'\n', r'\Z')
    return ordered_files, re.compile(strip_pattern), None


def _top_level_definitions(tree):
    own_defs = {}
    exported = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            own_defs.setdefault(node.name, node.lineno)
            exported.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for sub in ast.walk(target):
                    if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store) and sub.id != '_':
                        own_defs.setdefault(sub.id, node.lineno)
                        exported.add(sub.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id != '_':
            own_defs.setdefault(node.target.id, node.lineno)
            exported.add(node.target.id)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                exported.add(alias.asname if alias.asname else alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    exported.add(alias.asname if alias.asname else alias.name)
    return own_defs, exported


def check_installer_concatenation(root, product_sources, product_trees):
    build_path = root / 'scripts/install/build-installer.mjs'
    if not build_path.is_file():
        return []
    ordered_files, strip_re, parse_error = _parse_build_installer(build_path)
    if parse_error:
        return [f'scripts/install/build-installer.mjs: {parse_error}']
    errors = []
    order_index = {}
    exports_by_stem = {}
    owners = {}
    for idx, filename in enumerate(ordered_files):
        rel = f'scripts/install/{filename}'
        stem = Path(filename).stem
        order_index[stem] = idx
        if rel not in product_trees:
            errors.append(f'scripts/install/build-installer.mjs: missing concatenated module {rel}')
            continue
        own_defs, exported = _top_level_definitions(product_trees[rel])
        exports_by_stem[stem] = exported
        for symbol, lineno in sorted(own_defs.items()):
            if symbol in owners:
                errors.append(
                    f"{rel}:{lineno}: install.sh global namespace collision for '{symbol}' (already defined in {owners[symbol]})"
                )
            else:
                owners[symbol] = rel

    for idx, filename in enumerate(ordered_files):
        rel = f'scripts/install/{filename}'
        if rel not in product_trees:
            continue
        lines = product_sources[rel].splitlines()
        tree = product_trees[rel]
        for lineno, line in enumerate(lines, 1):
            if '# embedded-' in line and not strip_re.match(line):
                errors.append(f'{rel}:{lineno}: # embedded-* import does not match build-installer.mjs strip pattern')
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = alias.name.split('.')[0]
                    is_local = target in MODULE_LAYER or target.startswith('installer_') or target in ('updater', 'preview')
                    if target in order_index:
                        errors.append(
                            f"{rel}:{node.lineno}: bare 'import {target}' cannot be stripped in install.sh; use 'from {target} import ... # embedded-*'"
                        )
                    elif is_local:
                        errors.append(
                            f"{rel}:{node.lineno}: concatenated module cannot import non-concatenated local module '{target}'"
                        )
                continue
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            target = node.module.split('.')[0]
            is_local = target in MODULE_LAYER or target.startswith('installer_') or target in ('updater', 'preview')
            if target not in order_index:
                if is_local:
                    errors.append(
                        f"{rel}:{node.lineno}: concatenated module cannot import non-concatenated local module '{target}'"
                    )
                continue
            if node.lineno != node.end_lineno:
                errors.append(f'{rel}:{node.lineno}: embedded import from {target} must stay on a single line')
                continue
            line = lines[node.lineno - 1]
            expected_tag = '# embedded-' + target.removeprefix('installer_').replace('_', '-')
            if expected_tag not in line or not strip_re.match(line):
                errors.append(f"{rel}:{node.lineno}: import from concatenated module '{target}' requires matching '{expected_tag}' marker")
            if order_index[target] >= idx:
                errors.append(
                    f"{rel}:{node.lineno}: install.sh concatenation order violates dependency on '{target}' (listed after {filename})"
                )
            target_exports = exports_by_stem.get(target, set())
            for alias in node.names:
                if alias.name == '*':
                    continue
                if alias.asname is not None and alias.asname != alias.name:
                    errors.append(
                        f"{rel}:{node.lineno}: embedded import '{alias.name} as {alias.asname}' cannot rename symbol stripped in install.sh"
                    )
                if alias.name not in target_exports:
                    errors.append(f"{rel}:{node.lineno}: embedded import '{alias.name}' is not exported by {target}.py")
    return errors


def check_wording_and_suite_identity(rel, source):
    errors = []
    restricted = RESTRICTED_WORDING_RE.search(source)
    if restricted:
        line_no = source[:restricted.start()].count('\n') + 1
        errors.append(f'{rel}:{line_no}: restricted product-tier wording is forbidden')
    cleaned = INFRA_CHROMIUM_RE.sub('', source)
    suite = SUITE_IDENTITY_RE.search(cleaned)
    if suite:
        line_no = cleaned[:suite.start()].count('\n') + 1
        errors.append(
            f"{rel}:{line_no}: concrete suite identities belong in the signed online catalog, not platform code: '{suite.group(0)}'"
        )
    return errors


def check_file_size(rel, count, exemptions, allowed_executor_paths):
    errors = []
    exemption = exemptions.get(rel)
    if exemption is not None and rel not in allowed_executor_paths:
        errors.append(f'{rel}: size exemption is only allowed for legacy executor modules in executor-files.json')
        if count > CODE_LINE_LIMIT:
            errors.append(f'{rel}: nonblank noncomment lines {count} exceed {CODE_LINE_LIMIT}')
        return errors
    if exemption is None:
        if count > CODE_LINE_LIMIT:
            errors.append(f'{rel}: nonblank noncomment lines {count} exceed {CODE_LINE_LIMIT}')
        return errors
    if not isinstance(exemption, dict) or type(exemption.get('maxLines')) is not int or not isinstance(exemption.get('ticket'), str):
        errors.append(f'{rel}: invalid size exemption entry')
        return errors
    if count <= CODE_LINE_LIMIT:
        errors.append(f'{rel}: nonblank noncomment lines {count} are within {CODE_LINE_LIMIT}; remove its size exemption')
    elif count > exemption['maxLines']:
        errors.append(
            f"{rel}: nonblank noncomment lines {count} exceed the ratcheted {exemption['maxLines']} until {exemption['ticket']} splits it"
        )
    elif count < exemption['maxLines']:
        errors.append(
            f"{rel}: nonblank noncomment lines {count} are below the ratcheted {exemption['maxLines']}; lower its maxLines to {count}"
        )
    return errors


def _load_json(path, default):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding='utf-8'))


def _parse_python_file(rel, path, errors):
    source = path.read_text(encoding='utf-8')
    try:
        tree = ast.parse(source, filename=rel)
        compile(tree, rel, 'exec')
    except (SyntaxError, ValueError) as exc:
        errors.append(f'{rel}:{getattr(exc, "lineno", 1)}: syntax error: {exc}')
        return None, None
    return source, tree


def audit_repository(root):
    root = Path(root).resolve()
    errors = []
    exemptions_data = _load_json(root / 'architecture-exemptions.json', {'fileSize': {}})
    exemptions = exemptions_data.get('fileSize', {}) if isinstance(exemptions_data, dict) else {}
    executor_list = _load_json(root / 'scripts/install/executor-files.json', [])
    allowed_executor_paths = {f'scripts/install/{item}' for item in executor_list if isinstance(item, str)}

    product_files = []
    install_dir = root / 'scripts/install'
    if install_dir.is_dir():
        product_files.extend(sorted(install_dir.glob('*.py')))
    download_sources = root / 'scripts/download-sources.py'
    if download_sources.is_file():
        product_files.append(download_sources)
    dev_dir = root / 'scripts/dev'
    dev_files = sorted(dev_dir.glob('*.py')) if dev_dir.is_dir() else []
    fixtures_dir = root / 'tests/fixtures'
    fixture_files = sorted(fixtures_dir.glob('*.py')) if fixtures_dir.is_dir() else []

    scanned_script_paths = {p.relative_to(root).as_posix() for p in product_files + dev_files}
    for rel in sorted(exemptions):
        if rel.startswith('scripts/') and rel not in allowed_executor_paths and rel not in scanned_script_paths:
            errors.append(f'{rel}: size exemption is only allowed for legacy executor modules in executor-files.json')

    product_sources = {}
    product_trees = {}
    for path in product_files:
        rel = path.relative_to(root).as_posix()
        source, tree = _parse_python_file(rel, path, errors)
        if tree is None:
            continue
        product_sources[rel] = source
        product_trees[rel] = tree
        errors.extend(check_scope(rel, tree))
        errors.extend(check_no_inline_statements(rel, source, tree))
        errors.extend(check_file_size(rel, count_code_lines(source), exemptions, allowed_executor_paths))
        errors.extend(check_error_text_branches(rel, tree))
        errors.extend(check_wording_and_suite_identity(rel, source))

    if product_trees:
        errors.extend(check_layers_and_dag(product_trees))
        errors.extend(check_installer_concatenation(root, product_sources, product_trees))

    for path in dev_files:
        rel = path.relative_to(root).as_posix()
        source, tree = _parse_python_file(rel, path, errors)
        if tree is None:
            continue
        errors.extend(check_scope(rel, tree))
        errors.extend(check_no_inline_statements(rel, source, tree))
        errors.extend(check_file_size(rel, count_code_lines(source), exemptions, allowed_executor_paths))

    for path in fixture_files:
        rel = path.relative_to(root).as_posix()
        _parse_python_file(rel, path, errors)

    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description='Check Python architecture and style guardrails.')
    parser.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args(argv)
    errors = audit_repository(Path(args.root))
    if errors:
        for error in errors:
            sys.stderr.write(f'{error}\n')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
