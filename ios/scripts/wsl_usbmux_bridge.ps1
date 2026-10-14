# Run once, as administrator, on Windows. Lets xtool in WSL reach the iPhone
# through Apple's own usbmuxd (Apple Mobile Device Service, from iTunes or the
# Apple Devices app) instead of usbipd. Over usbipd, the upload to the device
# fails with "message was too large (65536 bytes, max = 65535)"
# (libimobiledevice/usbmuxd#247).
#
# 1. Returns any iPhone bound by usbipd to Windows' Apple driver.
# 2. Forwards 27015 on the WSL host address (vEthernet (WSL)) to Apple's
#    usbmuxd on 127.0.0.1, with a firewall rule for WSL's private range only.
# ios/scripts/xtool_install.sh finds this port and uses it automatically.
$usbipd = "C:\Program Files\usbipd-win\usbipd.exe"
if (Test-Path $usbipd) {
    foreach ($line in (& $usbipd list | Select-String "05ac:")) {
        $bus = ($line.ToString().Trim() -split '\s+')[0]
        & $usbipd detach --busid $bus 2>$null
        & $usbipd unbind --busid $bus
    }
}
$hostIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -like "vEthernet (WSL*" } |
    Select-Object -First 1).IPAddress
if (-not $hostIp) { throw "No vEthernet (WSL) adapter; start WSL first." }
netsh interface portproxy delete v4tov4 listenaddress=$hostIp listenport=27015 | Out-Null
netsh interface portproxy add v4tov4 listenaddress=$hostIp listenport=27015 connectaddress=127.0.0.1 connectport=27015
Remove-NetFirewallRule -DisplayName "WSL to Apple usbmuxd" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "WSL to Apple usbmuxd" -Direction Inbound -Protocol TCP `
    -LocalPort 27015 -LocalAddress $hostIp -RemoteAddress 172.16.0.0/12 -Action Allow | Out-Null
Restart-Service "Apple Mobile Device Service"
"Apple usbmuxd available to WSL at ${hostIp}:27015"
