# Process execution

Every process launched by this pack or by an agent following it runs without opening visible Windows windows. Use Node `spawn`/`execFile` with `windowsHide: true`, Python `creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)`, and PowerShell `Start-Process -WindowStyle Hidden` when starting a detached helper. Propagate the rule to child launchers. Use headless browsers and muted audio. Capture output and inspect exit status so invisibility retains diagnosability. Use the harness's noninteractive terminal execution for ordinary commands.

Keep model, reasoning effort and service tier at the authorized selection. A bundled tool's model defaults do not override task instructions; if incompatible, report the mismatch before invocation. Use fresh-context review only through permitted tools and authorization. A prohibition on delegation remains effective even when a skill describes delegation as a possible method.
