import { ethers } from 'ethers'
import { ENS } from '..'
import setup from './setup'
import { namehash } from '../utils/normalise'
import { NameWrapper } from '../../dist/types/generated/NameWrapper'
import { NamedFusesToBurn, validateFuses } from '../utils/fuses'

interface CallDetails {
  contract: 'nameWrapper' | 'baseRegistrar' | 'registry'
  method: 'setOwner' | 'setSubnodeOwner' | 'safeTransferFrom' | 'reclaim'
}

interface FunctionCallDetails {
  sendManager?: CallDetails
  sendOwner?: CallDetails
}

type BasicNameData = any

interface GetFunctionCallDetailsArgs {
  basicNameData: BasicNameData
  parentBasicNameData: BasicNameData
  name: string
  address: string
}

interface UserStates {
  owner: FunctionCallDetails
  manager: FunctionCallDetails
  parentManager?: FunctionCallDetails
  parentOwner?: FunctionCallDetails
}

interface NameStates {
  name: UserStates
  subname: UserStates
  wrappedSubname: UserStates
}

interface ContractFunctionInfo {
  unwrapped: NameStates
  wrapped: NameStates
}

const contractFunction: ContractFunctionInfo = {
  unwrapped: {
    name: {
      owner: {
        sendManager: {
          contract: 'baseRegistrar',
          method: 'reclaim',
        },
        sendOwner: {
          contract: 'baseRegistrar',
          method: 'safeTransferFrom',
        },
      },
      manager: {
        sendManager: {
          contract: 'registry',
          method: 'setOwner',
        },
      },
    },
    subname: {
      manager: {
        sendManager: {
          contract: 'registry',
          method: 'setOwner',
        },
      },
      owner: {},
      parentManager: {
        sendManager: {
          contract: 'registry',
          method: 'setSubnodeOwner',
        },
      },
      parentOwner: {
        // We shouldn't actually do this!
        // In parent change controller, then do what you would do as controller
        // sendManager: [],
      },
    },
    wrappedSubname: {
      manager: {
        sendManager: {
          contract: 'nameWrapper',
          method: 'safeTransferFrom',
        },
      },
      owner: {
        // This state should never happen as the parent is unwrapped and cannot burn PCC
      },
      parentManager: {
        // We shouldn't actually do this! Will forcibly unwrap the name
        // sendManager: {
        //   contract: 'registry',
        //   method: 'setSubnodeOwner',
        // },
      },
      parentOwner: {
        // Will require setting yourself as manager first
        // sendManager: [],
      },
    },
  },
  wrapped: {
    name: {
      owner: {
        sendOwner: {
          contract: 'nameWrapper',
          method: 'safeTransferFrom',
        },
      },
      manager: {
        sendManager: {
          contract: 'nameWrapper',
          method: 'safeTransferFrom',
        },
      },
    },
    wrappedSubname: {
      owner: {
        sendOwner: {
          contract: 'nameWrapper',
          method: 'safeTransferFrom',
        },
      },
      manager: {
        sendManager: {
          contract: 'nameWrapper',
          method: 'safeTransferFrom',
        },
      },
      parentManager: {
        sendManager: {
          contract: 'nameWrapper',
          method: 'setSubnodeOwner',
        },
      },
      parentOwner: {
        sendOwner: {
          contract: 'nameWrapper',
          method: 'setSubnodeOwner',
        },
        sendManager: {
          contract: 'nameWrapper',
          method: 'setSubnodeOwner',
        },
      },
    },
    subname: {
      manager: {
        sendManager: {
          contract: 'registry',
          method: 'setOwner',
        },
      },
      owner: {
        // Unwrapped subname cannot have an owner
      },
      parentManager: {
        // Must forcibly wrap subname or unwrap parent
        // sendManager: [],
      },
      parentOwner: {
        // Must forcibly wrap subname or unwrap parent
        // sendManager: [],
      },
    },
  },
}

const isASubname = (name: string) => name.split('.').length > 2

// Will pick out the correct function call from the object above
const getFunctionCallDetails = ({
  basicNameData,
  parentBasicNameData,
  name,
  address,
}: GetFunctionCallDetailsArgs): FunctionCallDetails => {
  const { ownerData, wrapperData } = basicNameData
  const { ownerData: parentOwnerData, wrapperData: parentWrapperData } =
    parentBasicNameData

  if (!wrapperData || !parentWrapperData) return {}

  const isSubname = isASubname(name)
  const { fuseObj } = wrapperData
  const { fuseObj: parentFuseObj } = parentWrapperData
  const isWrapped = ownerData?.ownershipLevel === 'nameWrapper'
  const isOwnerOrManager =
    ownerData?.owner === address || ownerData?.registrant === address
  const isOwner = isWrapped
    ? fuseObj.PARENT_CANNOT_CONTROL
    : ownerData?.registrant === address

  if (isSubname) {
    const isParentWrapped = parentOwnerData?.ownershipLevel === 'nameWrapper'
    const isParentOwnerOrManager = parentOwnerData?.owner === address

    if (!isOwnerOrManager && !isParentOwnerOrManager) {
      return {}
    }

    if (isOwnerOrManager) {
      const functionCallDetails =
        contractFunction[isParentWrapped ? 'wrapped' : 'unwrapped'][
          isWrapped ? 'wrappedSubname' : 'subname'
        ][isOwner ? 'owner' : 'manager']
      return functionCallDetails
    }

    const isParentManager = isParentWrapped
      ? !parentFuseObj.PARENT_CANNOT_CONTROL
      : parentOwnerData?.owner === address

    if (isParentOwnerOrManager) {
      const functionCallDetails =
        contractFunction[isParentWrapped ? 'wrapped' : 'unwrapped'][
          isWrapped ? 'wrappedSubname' : 'subname'
        ][`parent${isParentManager ? 'Manager' : 'Owner'}`]
      return functionCallDetails ?? {}
    }
  }

  // 2LD names
  if (isOwnerOrManager) {
    const functionCallDetails =
      contractFunction[isWrapped ? 'wrapped' : 'unwrapped'].name[
        isOwner ? 'owner' : 'manager'
      ]

    return functionCallDetails
  }

  return {}
}

let ensInstance: ENS
let revert: Awaited<ReturnType<typeof setup>>['revert']
let provider: ethers.providers.JsonRpcProvider
let accounts: string[]
let nameWrapper: NameWrapper

beforeAll(async () => {
  ;({ ensInstance, revert, provider } = await setup())
  accounts = await provider.listAccounts()
  nameWrapper = await ensInstance.contracts!.getNameWrapper()!
})

afterAll(async () => {
  await revert()
})

const approve = async () => {
  nameWrapper = await ensInstance.contracts!.getNameWrapper()!
  const registry = (await ensInstance.contracts!.getRegistry()!).connect(
    provider.getSigner(1),
  )
  const setApprovedForAllTx = await registry.setApprovalForAll(
    nameWrapper.address,
    true,
  )
  await setApprovedForAllTx?.wait()
}

beforeEach(async () => {
  await revert()
})

type Test = {
  user: 'owner' | 'manager' | 'parentOwner' | 'parentManager'
  action: 'sendOwner' | 'sendManager'
  check:
    | boolean
    | {
        method: any
        args: [any] | [any, any]
        field: any
      }
  wrap?: boolean
  wrapParent?: boolean
  burnFuses?: NamedFusesToBurn
  burnParentFuses?: NamedFusesToBurn
}

const mergeBurnFuses = (a: NamedFusesToBurn, b: NamedFusesToBurn) => {
  return [
    ...a,
    ...b.filter((fuse: string) => !(a as string[]).includes(fuse)),
  ] as NamedFusesToBurn
}

const getTestName = (test: Test) => {
  const { user, check, action } = test
  const status = check ? 'succeed' : 'FAIL'
  const verb = action.replace(/([a-z](?=[A-Z]))/g, '$1 ').toLowerCase()
  return `should ${status} if user tries to ${verb} as the ${user}`
}

const configureEthName = async ({
  name,
  wrap,
  user,
  burnFuses,
}: {
  name: string
  user: 'owner' | 'manager'
  wrap?: boolean
  burnFuses?: NamedFusesToBurn
}) => {
  // Cannot be manager since PCC is automatically burned for 2LD eth names
  if (wrap && user === 'manager') return false
  if (wrap) {
    const owner = user === 'owner' ? accounts[2] : accounts[1]
    const tx = await ensInstance.wrapName(name, {
      wrappedOwner: owner,
      addressOrIndex: 1,
      fuseOptions: {
        CANNOT_UNWRAP: true,
      },
    })
    await tx.wait()

    if (burnFuses) {
      const tx2 = await ensInstance.burnFuses(name, {
        namedFusesToBurn: burnFuses,
        addressOrIndex: 1,
      })
      await tx2.wait()
    }
  } else if (user === 'manager') {
    const tx = await ensInstance.transferName(name, {
      newOwner: accounts[2],
      contract: 'registry',
      addressOrIndex: 1,
    })
    await tx.wait()
  } else if (user === 'owner') {
    const tx = await ensInstance.transferName(name, {
      newOwner: accounts[2],
      contract: 'baseRegistrar',
      addressOrIndex: 1,
    })
    await tx.wait()
  }
  return true
}

const configureSubname = async ({
  name,
  user,
  wrap,
  burnFuses,
}: {
  name: string
  user: 'owner' | 'manager'
  wrap?: boolean
  burnFuses?: NamedFusesToBurn
}) => {
  const [label, ...parentLabels] = name.split('.')
  const parentName = parentLabels.join('.')
  const parentDetails = await ensInstance.getOwner(parentName)

  const isParentWrapped = parentDetails?.ownershipLevel === 'nameWrapper'

  // Cannot burn PCC if parent is not wrapped
  if (wrap && !isParentWrapped && user === 'owner') return false
  // Cannot burn fuses if user is manager
  if (wrap && burnFuses && user === 'manager') return false
  // Owner of subname is parent manager
  if (!wrap && user === 'owner') return false
  if (wrap) {
    const owner = ['owner', 'manager'].includes(user)
      ? accounts[2]
      : accounts[1]

    const tx = await ensInstance.wrapName(name, {
      wrappedOwner: owner,
      addressOrIndex: 1,
    })
    await tx.wait()

    if (burnFuses) {
      const encodedFuses = validateFuses({
        namedFusesToBurn: mergeBurnFuses(burnFuses, [
          'PARENT_CANNOT_CONTROL',
          'CANNOT_UNWRAP',
        ]),
      })
      const expiryResp = await ensInstance.getExpiry(parentName)!
      const expiry = expiryResp!.expiry!.getTime() / 1000
      const _nameWrapper = nameWrapper.connect(provider.getSigner(owner))
      const burnTx = await _nameWrapper.setChildFuses(
        namehash(parentName),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label)),
        encodedFuses,
        ethers.BigNumber.from(expiry),
      )
      await burnTx.wait()
    }
  } else if (user === 'manager') {
    const tx = await ensInstance.transferName(name, {
      newOwner: accounts[2],
      contract: 'registry',
      addressOrIndex: 1,
    })
    await tx.wait()
  }

  return true
}

const configureName = async ({
  name,
  user,
  wrap,
  burnFuses,
}: {
  name: string
  user: 'owner' | 'manager'
  wrap?: boolean
  burnFuses?: NamedFusesToBurn
}) => {
  const labels = name.split('.')
  if (labels.length === 1) return false
  if (labels.length === 2)
    return configureEthName({ name, user, wrap, burnFuses })
  return configureSubname({ name, user, wrap, burnFuses })
}

const mergeUser = (
  user: 'owner' | 'manager' | 'parentOwner' | 'parentManager',
): 'owner' | 'manager' => {
  if (user === 'parentOwner') return 'owner'
  if (user === 'parentManager') return 'manager'
  return user
}

const baseTests: Test[] = [
  {
    user: 'owner',
    action: 'sendOwner',
    check: {
      method: 'getOwner',
      args: ['registrar'] as [string],
      field: 'registrant',
    },
  },
  {
    user: 'manager',
    action: 'sendManager',
    check: {
      method: 'getOwner',
      args: ['registry'] as [string],
      field: 'owner',
    },
  },
  {
    user: 'owner',
    action: 'sendOwner',
    wrap: true,
    check: {
      method: 'getOwner',
      args: ['nameWrapper'] as [string],
      field: 'owner',
    },
  },
  {
    // Technically impossible since PCC is automatically burned for 2LD names
    user: 'manager',
    action: 'sendManager',
    wrap: true,
    check: false,
  },
]

const subnameTests: Test[] = [
  {
    // Should fail since it would require transfering the parent name
    user: 'owner',
    action: 'sendOwner',
    check: false,
  },
  {
    user: 'owner',
    action: 'sendManager',
    check: false,
  },
  {
    // Manager cannot send ownership
    user: 'manager',
    action: 'sendManager',
    check: false,
  },
  {
    user: 'parentOwner',
    action: 'sendOwner',
    wrapParent: true,
    burnParentFuses: ['CANNOT_TRANSFER'],
    check: false,
  },
  // {
  //   user: 'parentManager',
  //   action: 'sendOwner',
  //   check: false,
  // },
  // {
  //   user: 'owner',
  //   wrap: true,
  //   wrapParent: true,
  //   action: 'sendOwner',
  //   check: false,
  // },
  // {
  //   user: 'manager',
  //   wrap: true,
  //   wrapParent: true,
  //   action: 'sendManager',
  //   check: {
  //     method: 'getOwner',
  //     args: ['registry'],
  //     field: 'owner',
  //   },
  // },
  // {
  //   user: 'parentOwner',
  //   wrap: true,
  //   wrapParent: true,
  //   action: 'sendOwner',
  //   check: false,
  // },
  // {
  //   user: 'parentManager',
  //   action: 'sendOwner',
  //   wrap: true,
  //   wrapParent: true,
  //   check: false,
  // },
]

describe('configureEthName', () => {
  it('should', async () => {
    await configureEthName({
      name: 'transfer.eth',
      user: 'owner',
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'registrar'))!.registrant,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    await configureEthName({
      name: 'transfer.eth',
      user: 'manager',
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'registry'))!.owner,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    await configureEthName({
      name: 'transfer.eth',
      user: 'owner',
      wrap: true,
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'nameWrapper'))!.owner,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    const success = await configureEthName({
      name: 'transfer.eth',
      user: 'manager',
      wrap: true,
    })
    expect(success).toBe(false)
  })
})

describe('configureSubname', () => {
  it('should', async () => {
    await configureSubname({
      name: 'test.transfer.eth',
      user: 'owner',
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'registrar'))!.registrant,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    await configureSubname({
      name: 'transfer.eth',
      user: 'manager',
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'registry'))!.owner,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    await configureSubname({
      name: 'transfer.eth',
      user: 'owner',
      wrap: true,
    })
    expect(
      (await ensInstance.getOwner('transfer.eth', 'nameWrapper'))!.owner,
    ).toBe(accounts[2])
  })

  it('should', async () => {
    const success = await configureSubname({
      name: 'transfer.eth',
      user: 'manager',
      wrap: true,
    })
    expect(success).toBe(false)
  })
})

describe('transferName', () => {
  describe('2LD names', () => {
    baseTests.forEach((test) => {
      const name = 'transfer.eth'
      const testName = getTestName(test)
      it(testName, async () => {
        const { wrap, burnFuses, check, action, user } = test

        const parentName = name.split('.').slice(1).join('.')

        const configName = await configureName({
          name,
          wrap,
          user: mergeUser(user),
          burnFuses,
        })
        if (!configName) {
          expect(check).toBe(false)
          return
        }

        const basicNameData = {
          ownerData: await ensInstance.getOwner(name),
          wrapperData: await ensInstance.getWrapperData(name),
        }

        const parentBasicNameData = {
          ownerData: await ensInstance.getOwner(parentName),
          wrapperData: await ensInstance.getWrapperData(parentName),
        }

        const functionCallDetails = getFunctionCallDetails({
          basicNameData,
          parentBasicNameData,
          name,
          address: accounts[2],
        })

        const contractInfo = functionCallDetails[action]

        if (!contractInfo) {
          expect(check).toBe(false)
          return
        }

        const tx = await ensInstance.transferName(name, {
          newOwner: accounts[0],
          contract: contractInfo.contract,
          reclaim: contractInfo.method === 'reclaim',
          addressOrIndex: 2,
        })
        await tx.wait()

        if (typeof check === 'boolean')
          throw new Error('check should not be boolean')

        const { method, args, field } = check
        const result = await ensInstance[method](name, ...args)
        expect(result[field]).toBe(accounts[0])
      })
    })
  })

  describe(`3LD names`, () => {
    subnameTests.forEach((test) => {
      const name = 'test.transfer.eth'
      const testName = getTestName(test)
      it(testName, async () => {
        await approve()
        const {
          user,
          wrap,
          wrapParent,
          burnFuses,
          burnParentFuses,
          check,
          action,
        } = test

        const parentName = name.split('.').slice(1).join('.')

        const configParentName = await configureName({
          name: parentName,
          user: mergeUser(user),
          wrap: wrapParent,
          burnFuses: burnParentFuses,
        })
        if (!configParentName) {
          expect(check).toBe(false)
          return
        }

        const configName = await configureName({
          name,
          user: mergeUser(user),
          wrap,
          burnFuses,
        })
        if (!configName) {
          expect(check).toBe(false)
          return
        }

        // // Parent cannot be manager since PCC is automatically burned for 2LD .eth names
        // if (wrapParent && user === 'parentManager') {
        //   expect(check).toBe(false)
        //   return
        // }

        // if (wrapParent) {
        //   const owner = user === 'parentOwner' ? accounts[2] : accounts[1]
        //   const tx = await ensInstance.wrapName(parentName, {
        //     wrappedOwner: owner,
        //     fuseOptions: {
        //       CANNOT_UNWRAP: true,
        //     },
        //     addressOrIndex: 1,
        //   })
        //   await tx.wait()

        //   if (burnParentFuses) {
        //     const tx2 = await ensInstance.burnFuses(parentName, {
        //       namedFusesToBurn: burnParentFuses,
        //       addressOrIndex: owner,
        //     })
        //     await tx2.wait()
        //   }
        // }

        // if (!wrapParent && user === 'parentManager') {
        //   const tx = await ensInstance.transferName(parentName, {
        //     newOwner: accounts[2],
        //     contract: 'registry',
        //     addressOrIndex: 1,
        //   })
        //   await tx.wait()
        // }

        // if (!wrapParent && user === 'parentOwner') {
        //   const tx = await ensInstance.transferName(parentName, {
        //     newOwner: accounts[2],
        //     contract: 'baseRegistrar',
        //     addressOrIndex: 1,
        //   })
        //   await tx.wait()
        // }

        // /**
        //  * Set up name
        //  */

        // // User cannot be owner if the parent is not wrapped because PCC cannot be burned
        // if (wrap && !wrapParent && user === 'owner') {
        //   expect(check).toBe(false)
        //   return
        // }

        // if (wrap) {
        //   const owner = ['owner', 'manager'].includes(user)
        //     ? accounts[2]
        //     : accounts[1]

        //   const tx = await ensInstance.wrapName(name, {
        //     wrappedOwner: owner,
        //     addressOrIndex: 1,
        //   })
        //   await tx.wait()

        //   if (burnFuses) {
        //     const encodedFuses = validateFuses({
        //       namedFusesToBurn: mergeBurnFuses(burnFuses, [
        //         'PARENT_CANNOT_CONTROL',
        //       ]),
        //     })
        //     const expiryResp = await ensInstance.getExpiry(parentName)!
        //     const expiry = expiryResp!.expiry!.getTime() / 1000
        //     const _nameWrapper = nameWrapper.connect(provider.getSigner(1))
        //     const unlockTx = await _nameWrapper.setChildFuses(
        //       namehash(parentName),
        //       ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label)),
        //       encodedFuses,
        //       ethers.BigNumber.from(expiry),
        //     )
        //     await unlockTx.wait()
        //   }
        // }

        // if (!wrap && user === 'manager') {
        // }

        // if (!wrap && user === 'owner') {
        // }

        const basicNameData = {
          ownerData: await ensInstance.getOwner(name),
          wrapperData: await ensInstance.getWrapperData(name),
        }

        const parentBasicNameData = {
          ownerData: await ensInstance.getOwner(parentName),
          wrapperData: await ensInstance.getWrapperData(parentName),
        }

        const functionCallDetails = getFunctionCallDetails({
          basicNameData,
          parentBasicNameData,
          name,
          address: accounts[2],
        })

        const contractInfo = functionCallDetails[action]

        if (!contractInfo) {
          expect(check).toBe(false)
          return
        }

        const isOwnerOrManger =
          basicNameData.ownerData?.registrant === accounts[2] ||
          basicNameData.ownerData?.owner === accounts[2]

        if (isOwnerOrManger) {
          const tx = await ensInstance.transferName(name, {
            newOwner: accounts[0],
            contract: contractInfo.contract,
            reclaim: contractInfo.method === 'reclaim',
            addressOrIndex: 2,
          })
          await tx.wait()
        } else {
          if (contractInfo.contract === 'baseRegistrar')
            throw new Error('Subnames should not use base registrar contract')
          const tx = await ensInstance.transferSubname(name, {
            owner: accounts[0],
            contract: contractInfo.contract,
            addressOrIndex: 2,
          })
          await tx.wait()
        }

        if (typeof check === 'boolean')
          throw new Error('check should not be boolean')

        const { method, args, field } = check
        const result = await ensInstance[method](name, ...args)
        expect(result[field]).toBe(accounts[0])
      })
    })
  })
})
