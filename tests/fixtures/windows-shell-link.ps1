$ErrorActionPreference = 'Stop'
# Read the original Unicode filename with IPersistFile, then stored values with IShellLinkW.
# https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinkw-getpath
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$linkPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHISEL_LAUNCH_LINK_UTF8))

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class ChiselShellLinkReader {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr data, uint flags);
        [PreserveSig] int GetIDList(out IntPtr list);
        [PreserveSig] int SetIDList(IntPtr list);
        [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int capacity);
        [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity);
        [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int capacity);
    }

    public static string[] Read(string path) {
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        try {
            ((IPersistFile)instance).Load(path, 0);
            IShellLinkW link = (IShellLinkW)instance;
            StringBuilder target = new StringBuilder(260);
            StringBuilder working = new StringBuilder(260);
            StringBuilder arguments = new StringBuilder(1024);
            // SLGP_RAWPATH reads the stored target instead of resolving/rebasing it.
            Marshal.ThrowExceptionForHR(link.GetPath(target, target.Capacity, IntPtr.Zero, 4));
            Marshal.ThrowExceptionForHR(link.GetWorkingDirectory(working, working.Capacity));
            Marshal.ThrowExceptionForHR(link.GetArguments(arguments, arguments.Capacity));
            return new string[] { target.ToString(), working.ToString(), arguments.ToString() };
        } finally {
            Marshal.FinalReleaseComObject(instance);
        }
    }
}
'@

$fields = [ChiselShellLinkReader]::Read($linkPath)
@{ LinkPath=$linkPath; Exists=[IO.File]::Exists($linkPath); TargetPath=$fields[0]; WorkingDirectory=$fields[1]; Arguments=$fields[2] } | ConvertTo-Json -Compress
