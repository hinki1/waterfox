#!/usr/bin/python
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import os
import sys

from buildconfig import substs
from mozbuild.base import MozbuildObject
from mozfile import TemporaryDirectory
from mozhttpd import MozHttpd
from mozprofile import FirefoxProfile, Profile, Preferences
from mozprofile.permissions import ServerLocations
from mozrunner import FirefoxRunner, CLI

PORT = 8888

PATH_MAPPINGS = {
    '/webkit/PerformanceTests': 'third_party/webkit/PerformanceTests',
    # It is tempting to map to `testing/talos/talos/tests` instead, to avoid
    # writing `tests/` in every path, but we can't do that because some files
    # refer to scripts located in `../..`.
    '/talos': 'testing/talos/talos',
}


if __name__ == '__main__':
    cli = CLI()
    debug_args, interactive = cli.debugger_arguments()
    runner_args = cli.runner_args()

    build = MozbuildObject.from_environment()

    binary = runner_args.get('binary')
    if not binary:
        binary = build.get_binary_path(where="staged-package")

    path_mappings = {
        k: os.path.join(build.topsrcdir, v)
        for k, v in PATH_MAPPINGS.items()
    }
    httpd = MozHttpd(port=PORT,
                     docroot=os.path.join(build.topsrcdir, "build", "pgo"),
                     path_mappings=path_mappings)
    httpd.start(block=False)

    locations = ServerLocations()
    locations.add_host(host='127.0.0.1',
                       port=PORT,
                       options='primary,privileged')

    with TemporaryDirectory() as profilePath:
        # TODO: refactor this into mozprofile
        prefpath = os.path.join(
            build.topsrcdir, "testing", "profiles", "prefs_general.js")
        prefs = {}
        prefs.update(Preferences.read_prefs(prefpath))
        interpolation = {"server": "%s:%d" % httpd.httpd.server_address,
                         "OOP": "false"}
        prefs = json.loads(json.dumps(prefs) % interpolation)
        for pref in prefs:
            prefs[pref] = Preferences.cast(prefs[pref])
        profile = FirefoxProfile(profile=profilePath,
                                 preferences=prefs,
                                 addons=[os.path.join(
                                     build.topsrcdir, 'tools', 'quitter', 'quitter@mozilla.org.xpi')],
                                 locations=locations)

        env = os.environ.copy()
        env["MOZ_CRASHREPORTER_NO_REPORT"] = "1"
        env["XPCOM_DEBUG_BREAK"] = "warn"

        # For VC12+, make sure we can find the right bitness of pgort1x0.dll
        if not substs.get('HAVE_64BIT_BUILD'):
            for e in ('VS140COMNTOOLS', 'VS120COMNTOOLS'):
                if e not in env:
                    continue

                vcdir = os.path.abspath(os.path.join(env[e], '../../VC/bin'))
                if os.path.exists(vcdir):
                    env['PATH'] = '%s;%s' % (vcdir, env['PATH'])
                    break

        # Add MOZ_OBJDIR to the env so that cygprofile.cpp can use it.
        env["MOZ_OBJDIR"] = build.topobjdir

        # Run Firefox a first time to initialize its profile
        runner = FirefoxRunner(profile=profile,
                               binary=binary,
                               cmdargs=['data:text/html,<script>Quitter.quit()</script>'],
                               env=env)
        runner.start()
        ret = runner.wait()
        if ret:
            print("Firefox exited with code %d during profile initialization"
                  % ret)
            httpd.stop()
            sys.exit(ret)

        jarlog = os.getenv("JARLOG_FILE")
        if jarlog:
            env["MOZ_JAR_LOG_FILE"] = os.path.abspath(jarlog)
            print "jarlog: %s" % env["MOZ_JAR_LOG_FILE"]

        cmdargs = ["http://localhost:%d/index.html" % PORT]
        runner = FirefoxRunner(profile=profile,
                               binary=binary,
                               cmdargs=cmdargs,
                               env=env)
        runner.start(debug_args=debug_args, interactive=interactive)
        ret = runner.wait()
        httpd.stop()
        if ret:
            print("Firefox exited with code %d during profiling" % ret)
            sys.exit(ret)
