/** Runs inside the Docker microVM. Diagnostics must never enter the SDK's JSON stdout. */
export const SANDBOX_GUEST_GUARD = String.raw`
import fcntl, ipaddress, os, pwd, signal, socket, subprocess, sys, threading
from pathlib import Path

def run(*args, check=True):
    return subprocess.run(args, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def protect():
    if os.geteuid() != 0:
        raise RuntimeError('Sandbox guard requires root')
    gateway = str(ipaddress.IPv4Address(socket.gethostbyname('gateway.docker.internal')))
    dns = []
    for line in Path('/etc/resolv.conf').read_text().splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[0] == 'nameserver':
            address = ipaddress.ip_address(parts[1])
            if address.version == 4: dns.append(str(address))
    if not dns: raise RuntimeError('Sandbox DNS unavailable')
    # One immutable chain per VM. Never flush a live session's rules on a second launch.
    for tool in ('iptables', 'ip6tables'):
        chain = 'RLY0_PROXY_ONLY'
        expected = [['-o', 'lo', '-j', 'ACCEPT']]
        if tool == 'iptables':
            expected.append(['-d', gateway + '/32', '-p', 'tcp', '-m', 'tcp', '--dport', '3128', '-j', 'ACCEPT'])
            for resolver in dns:
                for protocol in ('tcp', 'udp'):
                    expected.append(['-d', resolver + '/32', '-p', protocol, '-m', protocol, '--dport', '53', '-j', 'ACCEPT'])
        expected.append(['-j', 'REJECT', '--reject-with', 'icmp-port-unreachable' if tool == 'iptables' else 'icmp6-port-unreachable'])
        if run(tool, '-w', '5', '-N', chain, check=False).returncode == 0:
            for rule in expected: run(tool, '-w', '5', '-A', chain, *rule)
        rules = run(tool, '-w', '5', '-S', chain).stdout.decode().splitlines()
        if rules != ['-N ' + chain] + ['-A ' + chain + ' ' + ' '.join(rule) for rule in expected]:
            raise RuntimeError('Sandbox guard incomplete')
        if run(tool, '-w', '5', '-C', 'OUTPUT', '-j', chain, check=False).returncode != 0:
            run(tool, '-w', '5', '-I', 'OUTPUT', '1', '-j', chain)

with open('/run/rly0-sandbox-guard.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    protect()
if len(sys.argv) == 1: sys.exit(0)
agent = pwd.getpwnam('agent')
env = {k:v for k,v in os.environ.items() if k in ('PATH', 'TERM', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS')}
env.update(HOME=agent.pw_dir, USER='agent', LOGNAME='agent', CLAUDE_CODE_ENTRYPOINT='codexhost-sdk', CLAUDE_AGENT_SDK_CLIENT_APP='rly0-hub-isolated')
def demote():
    os.setgroups([])
    os.setgid(agent.pw_gid)
    os.setuid(agent.pw_uid)
if sys.argv[1] == '--interactive':
    demote()
    env['CLAUDE_CODE_ENTRYPOINT'] = 'cli'
    os.execvpe(sys.argv[2], sys.argv[2:], env)
if sys.argv[1] == '--login':
    env['CLAUDE_CODE_ENTRYPOINT'] = 'cli'
    sys.argv.pop(1)
child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, env=env, start_new_session=True, preexec_fn=demote)
def close_group():
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
def forward():
    try:
        while True:
            chunk = os.read(0, 65536)
            if not chunk: break
            child.stdin.write(chunk)
            child.stdin.flush()
    except (BrokenPipeError, OSError): pass
    finally: close_group()
threading.Thread(target=forward, daemon=True).start()
try: sys.exit(child.wait())
finally: close_group()
`;
