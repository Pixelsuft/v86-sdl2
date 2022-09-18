import os
import sys
import subprocess


cwd = os.path.dirname(__file__) or os.getcwd()
in_file = os.path.join(cwd, 'net.c')
out_file = os.path.join(cwd, 'net.' + ('dll' if sys.platform == 'win32' else 'so'))

result = subprocess.call([
    'cc',
    '-shared',
    '-fPIC',
    '-o',
    out_file,
    in_file,
    '-lpcap'
] + sys.argv[1:])
if result:
    print('Compilaion failed')
