---
title: What I Wish I Knew Before Going Headless
mathjax: false
date: 2025-07-18 05:15:00
tags: 
  - Linux
categories: Technology
---

> This article is still under construction. The final version will be released in the near future.

> ### TL;DR
>
> I aimed to streamline my workflow using a single machine but encountered limitations across platforms—Windows became unstable, Arch required excessive maintenance, and macOS lacked NVIDIA GPU support.
>
>Ultimately, I adopted a headless Linux setup accessed via SSH and VSCode with Dev Containers from my Mac. This approach offers stability, flexibility, and strong remote development capabilities—though GUI dependencies still remain unavoidable in some cases.

## The Myth of the Perfect Setup

I’ve always been a fan of **using a single computer for everything**. Back when I was on Windows, my setup was a ThinkPad X1 Extreme paired with a Thunderbolt GPU dock—one machine to handle it all. But as Windows grew increasingly bloated and less efficient, I started searching for alternatives.

My first attempt was with Arch Linux. I loved the freedom to customize every detail. However, I soon found myself spending more time tweaking and maintaining the system than actually getting things done. Around that time, Apple announced the M2 MacBook Air, promising a fanless, silent, and efficient laptop. As someone who’s always loved lightweight laptops (my ThinkPad was a favorite for cramming high-voltage Intel CPUs into a slim chassis), I decided to give it a shot.

As I worked with it, I realized the operating system wasn’t really a dealbreaker for most modern workflows. Nearly all of my daily tasks were handled by cross-platform apps like VSCode, Chrome, or web-based tools. What truly made a difference was the fanless, slim design. The impressive battery life, strong M2 performance, and Unix-like environment (installing MacTeX was a breeze) were just added bonuses—but those are topics for another post.

But there was one big problem with macOS: it doesn’t support NVIDIA GPUs at all. The research team I was working with relied heavily on NVIDIA cards for machine learning tasks, so this was a serious limitation. I began looking for ways to reconcile my obsession with having only one computer for everything with the reality that **I now needed two**.

I need one of them to be headless, I insist.

## Back to Windows, Briefly

My second rig back then was an Intel NUC. Carrying a second laptop with me just didn’t feel elegant.

Before installing the OS, a memory came to mind: remote desktop under Linux usually requires a connected HDMI display, but Windows RDP can connect even without a monitor attached. That’s actually pretty useful. Sometimes I work with OpenCV and need to see the real-time video feed. Any remote video solution tends to add unnecessary complexity to the code.

Thinking I’d mostly be working inside WSL anyway—and considering that Windows supports SSH connections also—I decided to give Windows another shot.

Everything worked well for the first few years. The [**Remote - SSH**](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) plugin for VSCode worked perfectly with the Windows host and was even able to detect WSL instances automatically when connected. I was impressed enough that when I upgraded to a custom-built PC, I reused the same system drive, thinking Windows might offer better hardware compatibility anyway.

However, things started to fall apart once I began running some heavy experiments that took several days to complete:

- Random `HYPERVISOR_ERROR` crashes would shut down the workstation.
- WSL instances shut off when idle—even if the “idle” was caused by a script error I needed to see. I had to RDP in and rerun things manually (even `screen` didn’t help. Windows kills WSL unless the terminal is visible).
- VSCode lost connection to the code server whenever my Mac went to sleep, so I had to keep it awake just to monitor long-running Jupyter notebook jobs.

So in the end, I had to give up even the idea of using this RTX 4090 machine for gaming (despite the fact that I only play Overwatch). I was ready to wipe the drive and install Linux.

## You Can Leave Windows, But Not Microsoft

The first thing that came to mind was reusing the [**Remote - SSH**](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) plugin in VSCode, which I had been using to connect to WSL instances on my Windows setup. While going through the docs, I stumbled upon another plugin called [**Dev Containers**](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).

That’s when things started to click.

```
                              +-----------------+
                              |   Workstation   |
                              |                 |
                              |  +-----------+  |
                              |  |code server|  |
+----------+                  |  +-----------+  |
|    Mac   | ----- ssh -----> |       ^ |       |
| (vscode) | <--- tunnel ---- |       | v       |
+----------+                  |    +------+     |
                              |    |docker|     |
                              |    +------+     |
                              +-----------------+
```

Back on Windows, I used to manage several WSL instances, mainly because some older software only worked on legacy systems (see [this issue](https://github.com/Pang-Yatian/Point-MAE/pull/64))).

*And no, please don’t ask why I didn’t use Docker on Windows—the networking issues nearly drove me insane back then. I don’t know if things have improved since, maybe they have.*

After setting up SSH credentials and Docker on my workstation, I was immediately blown away by how well this workflow performs:

- **Session Resilience.** Sessions restore perfectly even after a connection drop. The processes keep running—and even the terminal state survives.
>My beta macOS conveniently crashed `windowserver` mid-session, so I had a chance to test this. 🤣
- **Easy OS Switching.** Switching OS versions is ridiculously easy by just editing the `FROM` line in `Dockerfile`.
- **All-in-one Configuration with `devcontainer.json`.** I love how powerful and tidy this file is. It lets me quickly set up everything I need with a few simple lines:
  - *Need a desktop environment?* Just add the desktop-lite under `feature`, and suddenly I have noVNC ready to go.
  - *Prefer certain VS Code extensions?* Just drop them into the customizations.vscode.extensions list, and they’re automatically installed in the container.
  - Docker configurations, port mappings, environment variables—all neatly packaged in one clear place.
- **Effortless Port Forwarding.** Dev container even handles port forwarding, so I could connect to noVNC inside the container from my Mac using just `localhost`!

## You never get rid of GUI


