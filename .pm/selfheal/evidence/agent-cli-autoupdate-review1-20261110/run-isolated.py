import json, os, pathlib, subprocess, sys, tempfile, time
cwd = "/Volumes/RLY0Dev/Dev/Projects/codex插件助手/.runtime/agent-cli-autoupdate"
label = sys.argv[1]
args = sys.argv[2:]
with tempfile.TemporaryDirectory(prefix="synthetic-cli-review1-check-") as root:
    env = dict(os.environ)
    env.update({k:str(pathlib.Path(root)/v) for k,v in {"HOME":"home","USERPROFILE":"home","CODEX_HOME":"codex","CODEXHOST_DATA_DIR":"data","RLY0_MEMORY_DIR":"memory","CLAUDE_CONFIG_DIR":"claude","APPDATA":"appdata","LOCALAPPDATA":"localappdata","npm_config_cache":"npm-cache"}.items()})
    env.update(RLY0_SKIP_LEGACY_IMPORT="1", RLY0_CODEX_UPDATE_CONTROL="0")
    for k in ["HOME","USERPROFILE","CODEX_HOME","CODEXHOST_DATA_DIR","RLY0_MEMORY_DIR","CLAUDE_CONFIG_DIR","APPDATA","LOCALAPPDATA"]: pathlib.Path(env[k]).mkdir(parents=True,exist_ok=True)
    started=time.time()
    p=subprocess.run(args,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    record={"label":label,"cwd":cwd,"command":args,"exitCode":p.returncode,"elapsedSeconds":round(time.time()-started,2),"isolated":True,"output":p.stdout}
    out=pathlib.Path("/tmp/agent-cli-review1-checks");out.mkdir(exist_ok=True)
    (out/(label+".json")).write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n")
    print(p.stdout[-18000:]); print(json.dumps({k:v for k,v in record.items() if k!="output"},ensure_ascii=False))
    sys.exit(p.returncode)
