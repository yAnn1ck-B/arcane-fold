param location string = resourceGroup().location
param dnsLabel string = 'arcane-fold'
param vmSize string = 'Standard_B2s_v2'
param availabilityZone string = '2'
param adminSshPublicKey string

var vmName = 'arcane-fold'
var adminUsername = 'arcaneadmin'
var backupAccountName = 'arcanefold${uniqueString(resourceGroup().id)}'
var backupContainerName = 'postgres-backups'
var blobDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: vmName
  location: location
  zones: [
    availabilityZone
  ]
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
}

resource firewall 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: vmName
  location: location
  properties: {
    securityRules: [
      {
        name: 'InternetHttpHttps'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
          destinationPortRanges: [
            '80'
            '443'
          ]
        }
      }
    ]
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vmName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.43.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.43.0.0/26'
          defaultOutboundAccess: false
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: vmName
  location: location
  properties: {
    networkSecurityGroup: {
      id: firewall.id
    }
    ipConfigurations: [
      {
        name: 'app'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: publicIp.id
          }
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'app')
          }
        }
      }
    ]
  }
  dependsOn: [
    network
  ]
}

resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: '${vmName}-data'
  location: location
  zones: [
    availabilityZone
  ]
  sku: {
    name: 'StandardSSD_LRS'
  }
  properties: {
    diskSizeGB: 32
    creationData: {
      createOption: 'Empty'
    }
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  zones: [
    availabilityZone
  ]
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        name: '${vmName}-os'
        createOption: 'FromImage'
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
      dataDisks: [
        {
          lun: 0
          name: dataDisk.name
          createOption: 'Attach'
          deleteOption: 'Detach'
          managedDisk: {
            id: dataDisk.id
          }
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource backupAccount 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: backupAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: backupAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource backups 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: backupContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource backupRetention 'Microsoft.Storage/storageAccounts/managementPolicies@2024-01-01' = {
  parent: backupAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-postgres-backups'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${backupContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 45
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource backupWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: backups
  name: guid(backups.id, vm.id, blobDataContributor)
  properties: {
    roleDefinitionId: blobDataContributor
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output hostname string = publicIp.properties.dnsSettings.fqdn
output virtualMachine string = vm.name
output storageAccount string = backupAccount.name
output storageContainer string = backups.name
