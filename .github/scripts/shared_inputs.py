"""Whether a change to the shared inputs reaches each domain of ci-cd.yml.

`aube-lock.yaml` and `mise.toml` are edited for every part of the repository,
so a change to one says nothing on its own about the deploy or the Rust apps.
This prints `ts=`, `deploy=` and `rust=` (each `true` or `false`) for the
change between two commits:

- aube-lock.yaml: any change reaches `ts`, whose jobs install and check the
  whole workspace. It reaches `deploy` when an entry in the dependency closure
  of `packages/infra` (the Pulumi program) was added, removed or changed,
  following workspace links, plus the root's runtime `dependencies`, which
  Node's resolution can reach from any package. A change to the lockfile's
  settings or format reaches both.
- mise.toml: a tool a domain's jobs install (node and aube for `ts`; those and
  pulumi for `deploy`; rust for `rust`), a task they run or one those tasks
  depend on, or anything outside [tools] and [tasks], such as [env], which
  every job reads.

    python3 shared_inputs.py BASE HEAD
"""

import os
import re
import subprocess
import sys
import tomllib

TS_TOOLS = {"node", "aube"}
DEPLOY_TOOLS = {"node", "aube", "pulumi"}
RUST_TOOLS = {"rust"}
TS_TASKS = {"auth", "lint", "fmt:check", "typecheck", "test", "check:profiles"}
DEPLOY_TASKS = {"auth"}

ENTRY_SECTIONS = {"importers", "packages", "snapshots"}
DEP_SECTIONS = {"dependencies", "devDependencies", "optionalDependencies"}


def show(rev, path):
    out = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else ""


def unquote(s):
    s = s.strip()
    return s[1:-1] if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"" else s


def entry_key(line):
    """The key of a two-space-indented entry, quoted or not, with any inline `{}`."""
    body = line.strip()
    if body[0] in "'\"":
        return body[1 : body.index(body[0], 1)]
    return re.sub(r":(\s.*)?$", "", body)


def lock_units(text):
    """Each lockfile entry by (section, key); top-level keys outside the entry sections by ("top", key)."""
    units, current = {}, None
    for line in text.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" "):
            section = line.split(":", 1)[0]
            current = None if section in ENTRY_SECTIONS else ("top", section)
            if current:
                units[current] = [line]
            last_section = section
        elif current and current[0] == "top":
            units[current].append(line)
        elif line.startswith("  ") and not line.startswith("   "):
            current = (last_section, entry_key(line))
            units[current] = [line]
        elif current:
            units[current].append(line)
    return {k: "\n".join(v) for k, v in units.items()}


def deps(body, sections=DEP_SECTIONS):
    """(name, version) pairs an importer or snapshot entry depends on."""
    out, section, name = [], None, None
    for line in body.splitlines()[1:]:
        indent = len(line) - len(line.lstrip())
        text = line.strip()
        if indent == 4:
            section = text.rstrip(":")
        elif section not in sections:
            continue
        elif indent == 6:
            key, _, value = text.partition(":")
            name = unquote(key)
            if value.strip():
                out.append((name, unquote(value)))
        elif indent == 8 and text.startswith("version:"):
            out.append((name, unquote(text.partition(":")[2])))
    return out


def lock_reaches_deploy(old, new):
    before, after = lock_units(old), lock_units(new)
    changed = {k for k in before.keys() | after.keys() if before.get(k) != after.get(k)}
    if not changed:
        return False
    if any(section == "top" for section, _ in changed):
        return True

    def root_runtime(units):
        return deps(units.get(("importers", "."), ""), {"dependencies"})

    if root_runtime(before) != root_runtime(after):
        return True

    graph = {}
    for units in (before, after):
        for (section, key), body in units.items():
            if section == "importers" and key != ".":
                edges = graph.setdefault(("importers", key), set())
                for name, version in deps(body):
                    if version.startswith("link:"):
                        edges.add(("importers", os.path.normpath(os.path.join(key, version[5:]))))
                    else:
                        edges.add(("snapshots", f"{name}@{version}"))
            elif section == "snapshots":
                edges = graph.setdefault(("snapshots", key), set())
                for name, version in deps(body, {"dependencies", "optionalDependencies"}):
                    edges.add(("snapshots", f"{name}@{version}"))
        graph.setdefault(("importers", "packages/infra"), set()).update(
            ("snapshots", f"{name}@{version}") for name, version in root_runtime(units)
        )

    seen, stack = set(), [("importers", "packages/infra")]
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack.extend(graph.get(node, ()))
    # A `packages` entry holds what a snapshot of that name and version
    # installs, whatever peers the snapshot was resolved with.
    installed = {key.split("(", 1)[0] for section, key in seen if section == "snapshots"}
    return any(
        (section, key) in seen or (section == "packages" and key in installed)
        for section, key in changed
        if section != "importers" or key != "."
    )


def mise_reaches(old, new):
    """(ts, deploy, rust) for a change to mise.toml."""
    before = tomllib.loads(old) if old else {}
    after = tomllib.loads(new) if new else {}
    tools_before, tools_after = before.pop("tools", {}), after.pop("tools", {})
    tasks_before, tasks_after = before.pop("tasks", {}), after.pop("tasks", {})
    if before != after:
        return True, True, True
    tools = {t for t in tools_before.keys() | tools_after.keys() if tools_before.get(t) != tools_after.get(t)}
    tasks = {t for t in tasks_before.keys() | tasks_after.keys() if tasks_before.get(t) != tasks_after.get(t)}

    graph = {}
    for table in (tasks_before, tasks_after):
        for name, task in table.items():
            listed = task.get("depends", []) if isinstance(task, dict) else []
            graph.setdefault(name, set()).update(d.split()[0] for d in ([listed] if isinstance(listed, str) else listed))

    def reached(roots):
        seen, stack = set(), list(roots)
        while stack:
            name = stack.pop()
            if name not in seen:
                seen.add(name)
                stack.extend(graph.get(name, ()))
        return bool(seen & tasks)

    return (
        bool(tools & TS_TOOLS) or reached(TS_TASKS),
        bool(tools & DEPLOY_TOOLS) or reached(DEPLOY_TASKS),
        bool(tools & RUST_TOOLS),
    )


def main():
    base, head = sys.argv[1:3]
    old_lock, new_lock = show(base, "aube-lock.yaml"), show(head, "aube-lock.yaml")
    lock_ts = old_lock != new_lock
    lock_deploy = lock_ts and lock_reaches_deploy(old_lock, new_lock)
    mise_ts, mise_deploy, mise_rust = mise_reaches(show(base, "mise.toml"), show(head, "mise.toml"))
    print(f"ts={str(lock_ts or mise_ts).lower()}")
    print(f"deploy={str(lock_deploy or mise_deploy).lower()}")
    print(f"rust={str(mise_rust).lower()}")


main()
