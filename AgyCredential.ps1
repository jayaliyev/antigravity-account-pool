# Windows Credential Manager access for the local account pool.
# Credentials are never written as plaintext or printed.
$credInterop = @'
using System;
using System.Runtime.InteropServices;

public static class AgyCredentialInterop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential {
        public UInt32 Flags;
        public UInt32 Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public Int64 LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref NativeCredential credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr credential);

    public sealed class Snapshot {
        public string UserName;
        public byte[] Blob;
        public UInt32 Persist;
    }

    public static Snapshot Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CredRead failed");
        try {
            NativeCredential native = (NativeCredential)Marshal.PtrToStructure(ptr, typeof(NativeCredential));
            byte[] blob = new byte[native.CredentialBlobSize];
            if (blob.Length > 0) Marshal.Copy(native.CredentialBlob, blob, 0, blob.Length);
            return new Snapshot { UserName = native.UserName, Blob = blob, Persist = native.Persist };
        } finally { CredFree(ptr); }
    }

    public static void Write(string target, Snapshot snapshot) {
        IntPtr blobPtr = Marshal.AllocHGlobal(snapshot.Blob.Length);
        try {
            if (snapshot.Blob.Length > 0) Marshal.Copy(snapshot.Blob, 0, blobPtr, snapshot.Blob.Length);
            NativeCredential native = new NativeCredential();
            native.Type = 1;
            native.TargetName = target;
            native.UserName = snapshot.UserName;
            native.CredentialBlobSize = (UInt32)snapshot.Blob.Length;
            native.CredentialBlob = blobPtr;
            native.Persist = snapshot.Persist;
            if (!CredWrite(ref native, 0))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CredWrite failed");
        } finally { Marshal.FreeHGlobal(blobPtr); }
    }

    public static void Delete(string target) {
        if (!CredDelete(target, 1, 0))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CredDelete failed");
    }
}
'@

if (-not ('AgyCredentialInterop' -as [type])) {
    Add-Type -TypeDefinition $credInterop -ErrorAction Stop
}
