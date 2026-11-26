"""AST scope and Law 3 (error-text branching) checks for repository Python code."""
import ast
import builtins

BUILTINS = set(dir(builtins)) | {
    '__annotations__',
    '__builtins__',
    '__cached__',
    '__doc__',
    '__file__',
    '__name__',
    '__package__',
    '__spec__',
}

ERROR_TEXT_EXEMPT_FUNCTIONS = frozenset({
    ('scripts/install/installer_progress.py', 'operator_text'),
    ('scripts/install/installer_deployment_cli.py', 'reason_text'),
})
ERROR_VAR_NAMES = frozenset({'error', 'err', 'exc', 'exception', 'cause'})
ERROR_TEXT_ATTRS = frozenset({'message', 'failure'})
STRING_MATCH_METHODS = frozenset({
    'startswith',
    'endswith',
    'find',
    'rfind',
    'index',
    'rindex',
    'count',
    'lower',
    'upper',
    'casefold',
    'strip',
    'lstrip',
    'rstrip',
    'split',
    'rsplit',
})
REGEX_MATCH_FUNCS = frozenset({'search', 'match', 'fullmatch', 'findall', 'finditer'})


class _Scope:
    def __init__(self, kind):
        self.kind = kind
        self.imports = {}
        self.locals = {}
        self.params = set()
        self.defs = {}
        self.globals = set()
        self.nonlocals = set()
        self.loads = []
        self.children = []

    def bound_names(self):
        return set(self.imports) | set(self.locals) | self.params | set(self.defs)


class _ScopeCollector(ast.NodeVisitor):
    def __init__(self, rel):
        self.rel = rel
        self.root = _Scope('module')
        self.stack = [self.root]
        self.errors = []

    @property
    def current(self):
        return self.stack[-1]

    def _enter(self, kind):
        scope = _Scope(kind)
        self.current.children.append(scope)
        self.stack.append(scope)
        return scope

    def _leave(self):
        self.stack.pop()

    def _bind_local(self, name, lineno):
        scope = self.current
        if name in scope.globals:
            self.root.defs.setdefault(name, lineno)
        elif name not in scope.nonlocals:
            scope.locals.setdefault(name, lineno)

    def _bind_target(self, target, lineno):
        if isinstance(target, ast.Name):
            self._bind_local(target.id, getattr(target, 'lineno', lineno))
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._bind_target(elt, lineno)
        elif isinstance(target, ast.Starred):
            self._bind_target(target.value, lineno)
        else:
            self.visit(target)

    def visit_Import(self, node):
        for alias in node.names:
            bound = alias.asname if alias.asname else alias.name.split('.')[0]
            reexport = alias.asname is not None and alias.asname == alias.name
            existing = self.current.imports.get(bound)
            self.current.imports[bound] = (node.lineno, reexport or (existing[1] if existing else False))

    def visit_ImportFrom(self, node):
        if node.module == '__future__':
            return
        for alias in node.names:
            if alias.name == '*':
                self.errors.append(f'{self.rel}:{node.lineno}: wildcard import is forbidden')
                continue
            bound = alias.asname if alias.asname else alias.name
            reexport = alias.asname is not None and alias.asname == alias.name
            existing = self.current.imports.get(bound)
            self.current.imports[bound] = (node.lineno, reexport or (existing[1] if existing else False))

    def visit_Global(self, node):
        self.current.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.current.nonlocals.update(node.names)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Load, ast.Del)):
            self.current.loads.append((node.id, node.lineno))
        elif isinstance(node.ctx, ast.Store):
            self._bind_local(node.id, node.lineno)

    def visit_Assign(self, node):
        self.visit(node.value)
        for target in node.targets:
            self._bind_target(target, node.lineno)

    def visit_AnnAssign(self, node):
        if node.annotation is not None:
            self.visit(node.annotation)
        if node.value is not None:
            self.visit(node.value)
        if isinstance(node.target, ast.Name):
            if node.value is not None:
                self._bind_local(node.target.id, node.lineno)
        else:
            self.visit(node.target)

    def visit_AugAssign(self, node):
        if isinstance(node.target, ast.Name):
            self.current.loads.append((node.target.id, node.lineno))
            self._bind_local(node.target.id, node.lineno)
        else:
            self.visit(node.target)
        self.visit(node.value)

    def visit_NamedExpr(self, node):
        self.visit(node.value)
        target_scope = self.current
        for scope in reversed(self.stack):
            if scope.kind != 'comprehension':
                target_scope = scope
                break
        if isinstance(node.target, ast.Name):
            if node.target.id in target_scope.globals:
                self.root.defs.setdefault(node.target.id, node.lineno)
            elif node.target.id not in target_scope.nonlocals:
                target_scope.locals.setdefault(node.target.id, node.lineno)

    def visit_For(self, node):
        self.visit(node.iter)
        self._bind_target(node.target, node.lineno)
        for stmt in node.body:
            self.visit(stmt)
        for stmt in node.orelse:
            self.visit(stmt)

    visit_AsyncFor = visit_For

    def visit_With(self, node):
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self._bind_target(item.optional_vars, node.lineno)
        for stmt in node.body:
            self.visit(stmt)

    visit_AsyncWith = visit_With

    def visit_ExceptHandler(self, node):
        if node.type is not None:
            self.visit(node.type)
        if node.name:
            self._bind_local(node.name, node.lineno)
        for stmt in node.body:
            self.visit(stmt)

    def visit_MatchAs(self, node):
        if node.pattern is not None:
            self.visit(node.pattern)
        if node.name:
            self._bind_local(node.name, node.lineno)

    def visit_MatchStar(self, node):
        if node.name:
            self._bind_local(node.name, node.lineno)

    def visit_MatchMapping(self, node):
        for key in node.keys:
            self.visit(key)
        for pattern in node.patterns:
            self.visit(pattern)
        if node.rest:
            self._bind_local(node.rest, node.lineno)

    def _visit_function(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in node.args.defaults:
            self.visit(default)
        for default in node.args.kw_defaults:
            if default is not None:
                self.visit(default)
        all_args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
        if node.args.vararg:
            all_args.append(node.args.vararg)
        if node.args.kwarg:
            all_args.append(node.args.kwarg)
        for arg in all_args:
            if arg.annotation is not None:
                self.visit(arg.annotation)
        if node.returns is not None:
            self.visit(node.returns)
        self.current.defs.setdefault(node.name, node.lineno)
        scope = self._enter('function')
        for arg in all_args:
            scope.params.add(arg.arg)
        for stmt in node.body:
            self.visit(stmt)
        self._leave()

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node):
        for default in node.args.defaults:
            self.visit(default)
        for default in node.args.kw_defaults:
            if default is not None:
                self.visit(default)
        all_args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
        if node.args.vararg:
            all_args.append(node.args.vararg)
        if node.args.kwarg:
            all_args.append(node.args.kwarg)
        scope = self._enter('function')
        for arg in all_args:
            scope.params.add(arg.arg)
        self.visit(node.body)
        self._leave()

    def visit_ClassDef(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for kw in node.keywords:
            self.visit(kw.value)
        self.current.defs.setdefault(node.name, node.lineno)
        self._enter('class')
        for stmt in node.body:
            self.visit(stmt)
        self._leave()

    def _visit_comp(self, generators, elements):
        self.visit(generators[0].iter)
        self._enter('comprehension')
        for idx, gen in enumerate(generators):
            if idx > 0:
                self.visit(gen.iter)
            self._bind_target(gen.target, getattr(gen.target, 'lineno', 1))
            for cond in gen.ifs:
                self.visit(cond)
        for elt in elements:
            self.visit(elt)
        self._leave()

    def visit_ListComp(self, node):
        self._visit_comp(node.generators, [node.elt])

    def visit_SetComp(self, node):
        self._visit_comp(node.generators, [node.elt])

    def visit_GeneratorExp(self, node):
        self._visit_comp(node.generators, [node.elt])

    def visit_DictComp(self, node):
        self._visit_comp(node.generators, [node.key, node.value])


def check_scope(rel, tree):
    collector = _ScopeCollector(rel)
    collector.visit(tree)
    errors = list(collector.errors)
    used_in_scope = {}

    def resolve(scope, ancestors):
        used_in_scope[id(scope)] = set()
        visible = [anc for anc in ancestors if anc.kind != 'class'] + [scope]
        for name, lineno in scope.loads:
            if name in scope.globals:
                used_in_scope[id(collector.root)].add(name)
                if name not in collector.root.bound_names() and name not in BUILTINS:
                    errors.append(f"{rel}:{lineno}: undefined name '{name}'")
                continue
            found = None
            for candidate in reversed(visible):
                if name in candidate.bound_names():
                    found = candidate
                    break
            if found is not None:
                used_in_scope[id(found)].add(name)
            elif name not in BUILTINS:
                errors.append(f"{rel}:{lineno}: undefined name '{name}'")
        for child in scope.children:
            resolve(child, ancestors + [scope])

    resolve(collector.root, [])

    def audit_unused(scope):
        used = used_in_scope[id(scope)]
        for name, (lineno, reexport) in scope.imports.items():
            if not reexport and not name.startswith('_') and name not in used:
                errors.append(f"{rel}:{lineno}: unused import '{name}'")
        if scope.kind == 'function':
            for name, lineno in scope.locals.items():
                if not name.startswith('_') and name not in used and name not in scope.params:
                    errors.append(f"{rel}:{lineno}: unused local variable '{name}'")
        for child in scope.children:
            audit_unused(child)

    audit_unused(collector.root)
    return errors


def _is_error_name(node, exc_vars):
    return isinstance(node, ast.Name) and (node.id in exc_vars or node.id in ERROR_VAR_NAMES)


def _extract_error_text_expr(node, exc_vars, text_aliases):
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id == 'str' and len(node.args) == 1:
            if _is_error_name(node.args[0], exc_vars):
                return True
    if isinstance(node, ast.FormattedValue) and _is_error_name(node.value, exc_vars):
        return True
    if isinstance(node, ast.Attribute):
        if node.attr == 'args' and _is_error_name(node.value, exc_vars):
            return True
        if node.attr in ERROR_TEXT_ATTRS:
            return True
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and node.slice.value in ERROR_TEXT_ATTRS:
        if _is_error_name(node.value, exc_vars):
            return True
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'get':
        if node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value in ERROR_TEXT_ATTRS:
            if _is_error_name(node.func.value, exc_vars):
                return True
    if isinstance(node, ast.Name) and node.id in text_aliases:
        return True
    return False


def _contains_error_text(node, exc_vars, text_aliases):
    for sub in ast.walk(node):
        if _extract_error_text_expr(sub, exc_vars, text_aliases):
            return True
    return False


def _is_regex_call_on_error_text(node, exc_vars, text_aliases):
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
        return False
    if node.func.attr not in REGEX_MATCH_FUNCS:
        return False
    call_args = list(node.args) + [kw.value for kw in node.keywords]
    return any(_contains_error_text(arg, exc_vars, text_aliases) for arg in call_args)


STRING_TRANSFORM_METHODS = frozenset({
    'lower',
    'upper',
    'casefold',
    'strip',
    'lstrip',
    'rstrip',
    'replace',
    'split',
    'rsplit',
})
STRING_PREDICATE_METHODS = frozenset({
    'startswith',
    'endswith',
    'find',
    'rfind',
    'index',
    'rindex',
    'count',
})


def _is_direct_error_text(node, exc_vars, text_aliases):
    if _extract_error_text_expr(node, exc_vars, text_aliases):
        return True
    if isinstance(node, ast.JoinedStr):
        return any(_is_direct_error_text(val, exc_vars, text_aliases) for val in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _is_direct_error_text(node.left, exc_vars, text_aliases) or _is_direct_error_text(node.right, exc_vars, text_aliases)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in STRING_TRANSFORM_METHODS:
        return _is_direct_error_text(node.func.value, exc_vars, text_aliases)
    return False


def _is_error_predicate(node, exc_vars, text_aliases, match_aliases):
    if isinstance(node, ast.Name) and node.id in match_aliases:
        return True
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return _is_error_predicate(node.operand, exc_vars, text_aliases, match_aliases)
    if isinstance(node, ast.BoolOp):
        return any(_is_error_predicate(val, exc_vars, text_aliases, match_aliases) for val in node.values)
    if isinstance(node, ast.Compare):
        return _contains_error_text(node, exc_vars, text_aliases)
    if isinstance(node, ast.Call):
        if _is_regex_call_on_error_text(node, exc_vars, text_aliases):
            return True
        if isinstance(node.func, ast.Attribute) and node.func.attr in STRING_PREDICATE_METHODS:
            return _is_direct_error_text(node.func.value, exc_vars, text_aliases)
    return False


def _branch_inspects_error_text(test_node, exc_vars, text_aliases, match_aliases):
    for sub in ast.walk(test_node):
        if _is_error_predicate(sub, exc_vars, text_aliases, match_aliases):
            return True
        if isinstance(sub, ast.Call):
            if isinstance(sub.func, ast.Attribute) and sub.func.attr in STRING_MATCH_METHODS:
                if _is_direct_error_text(sub.func.value, exc_vars, text_aliases):
                    return True
            if isinstance(sub.func, ast.Name) and sub.func.id == 'str' and len(sub.args) == 1:
                if _is_error_name(sub.args[0], exc_vars):
                    return True
    return False


def check_error_text_branches(rel, tree):
    errors = []

    def inspect_block(stmts, exc_vars, text_aliases, match_aliases, qual_prefix):
        local_exc = set(exc_vars)
        local_text = set(text_aliases)
        local_match = set(match_aliases)

        def check_expr(expr):
            for node in ast.walk(expr):
                if isinstance(node, ast.IfExp) and _branch_inspects_error_text(node.test, local_exc, local_text, local_match):
                    errors.append(f'{rel}:{node.lineno}: law 3: business branch examines error or failure text')
                elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
                    for gen in node.generators:
                        for cond in gen.ifs:
                            if _branch_inspects_error_text(cond, local_exc, local_text, local_match):
                                errors.append(f'{rel}:{cond.lineno}: law 3: business branch examines error or failure text')

        def record_binding(targets, value):
            check_expr(value)
            is_err_match = _is_error_predicate(value, local_exc, local_text, local_match)
            is_err_text = _is_direct_error_text(value, local_exc, local_text)
            for target in targets:
                if isinstance(target, ast.Name):
                    if is_err_match:
                        local_match.add(target.id)
                        local_text.discard(target.id)
                    elif is_err_text:
                        local_text.add(target.id)
                        local_match.discard(target.id)
                    else:
                        local_text.discard(target.id)
                        local_match.discard(target.id)

        def merge_branch(branch_stmts, branch_exc):
            child_text, child_match = inspect_block(branch_stmts, branch_exc, local_text, local_match, qual_prefix)
            return child_text, child_match

        for stmt in stmts:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = f'{qual_prefix}.{stmt.name}' if qual_prefix else stmt.name
                if (rel, qual) not in ERROR_TEXT_EXEMPT_FUNCTIONS:
                    inspect_block(stmt.body, set(), set(), set(), qual)
                continue
            if isinstance(stmt, ast.ClassDef):
                qual = f'{qual_prefix}.{stmt.name}' if qual_prefix else stmt.name
                inspect_block(stmt.body, set(), set(), set(), qual)
                continue
            if isinstance(stmt, ast.Assign):
                record_binding(stmt.targets, stmt.value)
            elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
                record_binding([stmt.target], stmt.value)
            elif isinstance(stmt, ast.If):
                if _branch_inspects_error_text(stmt.test, local_exc, local_text, local_match):
                    errors.append(f'{rel}:{stmt.lineno}: law 3: business branch examines error or failure text')
                check_expr(stmt.test)
                bt, bm = merge_branch(stmt.body, local_exc)
                et, em = merge_branch(stmt.orelse, local_exc)
                local_text |= bt | et
                local_match |= bm | em
            elif isinstance(stmt, ast.While):
                if _branch_inspects_error_text(stmt.test, local_exc, local_text, local_match):
                    errors.append(f'{rel}:{stmt.lineno}: law 3: business branch examines error or failure text')
                check_expr(stmt.test)
                bt, bm = merge_branch(stmt.body, local_exc)
                et, em = merge_branch(stmt.orelse, local_exc)
                local_text |= bt | et
                local_match |= bm | em
            elif isinstance(stmt, (ast.For, ast.AsyncFor)):
                check_expr(stmt.iter)
                bt, bm = merge_branch(stmt.body, local_exc)
                et, em = merge_branch(stmt.orelse, local_exc)
                local_text |= bt | et
                local_match |= bm | em
            elif isinstance(stmt, (ast.With, ast.AsyncWith)):
                for item in stmt.items:
                    check_expr(item.context_expr)
                bt, bm = merge_branch(stmt.body, local_exc)
                local_text |= bt
                local_match |= bm
            elif isinstance(stmt, ast.Try) or (hasattr(ast, 'TryStar') and isinstance(stmt, ast.TryStar)):
                bt, bm = merge_branch(stmt.body, local_exc)
                merged_text, merged_match = set(bt), set(bm)
                for handler in stmt.handlers:
                    handler_exc = set(local_exc)
                    if handler.name:
                        handler_exc.add(handler.name)
                    ht, hm = merge_branch(handler.body, handler_exc)
                    merged_text |= ht
                    merged_match |= hm
                et, em = merge_branch(stmt.orelse, local_exc)
                ft, fm = merge_branch(stmt.finalbody, local_exc)
                local_text |= merged_text | et | ft
                local_match |= merged_match | em | fm
            elif hasattr(ast, 'Match') and isinstance(stmt, ast.Match):
                if _contains_error_text(stmt.subject, local_exc, local_text):
                    errors.append(f'{rel}:{stmt.lineno}: law 3: business branch examines error or failure text')
                for case in stmt.cases:
                    if case.guard is not None and _branch_inspects_error_text(case.guard, local_exc, local_text, local_match):
                        errors.append(f'{rel}:{case.guard.lineno}: law 3: business branch examines error or failure text')
                    ct, cm = merge_branch(case.body, local_exc)
                    local_text |= ct
                    local_match |= cm
            else:
                check_expr(stmt)
        return local_text, local_match

    inspect_block(tree.body, set(), set(), set(), '')
    return errors
