import { C1Engine } from '../c1/C1Engine.js';
import { C2Engine } from '../c2/C2Engine.js';
import type {
  ApexTxRequest,
  BuiltTx,
  NormalizedReceipt,
  SignedTx,
  TxSubmitter,
} from '../../types/index.js';

class FakeSubmitter implements TxSubmitter {
  async build(request: ApexTxRequest): Promise<BuiltTx> {
    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chainId: request.chainId,
      payloadHash: request.payloadHash,
    };
  }

  async sign(request: ApexTxRequest): Promise<SignedTx> {
    return {
      ...(await this.build(request)),
      nonce: request.nonce ?? 1,
      gasLimit: request.gasLimit,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      rawTx: '0xsigned',
      signerAddress: '0x0000000000000000000000000000000000000011',
    };
  }

  async submit(signed: SignedTx) {
    return {
      opportunityId: signed.opportunityId,
      cycleId: signed.cycleId,
      cycleType: signed.cycleId.startsWith('c2') ? 'C2' : 'C1',
      submitterAdapter: 'ethers_v6' as const,
      nonce: signed.nonce,
      gasLimit: signed.gasLimit.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
      submittedBlock: 101,
      expiresAtBlock: 110,
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      rawTxHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      payloadHash: signed.payloadHash,
      routeHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      stateHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      configHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      submissionStatus: 'SUBMITTED_PRIVATE' as const,
      receiptStatus: 'PENDING' as const,
    };
  }

  async wait(txHash: string): Promise<NormalizedReceipt> {
    return {
      txHash,
      receiptStatus: true,
      confirmedBlock: 102,
      gasUsed: '1',
      effectiveGasPrice: '1',
      gasCostWei: '1',
      from: '0x0000000000000000000000000000000000000011',
      to: '0x0000000000000000000000000000000000000022',
      logs: [],
      rawReceipt: {},
    };
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function testC1Commitment(): Promise<void> {
  const submitter = new FakeSubmitter();
  const engine = new C1Engine(submitter);
  const result = await engine.execute({
    opportunityId: 'opp-1',
    cycleId: 'c1-1',
    config: {
      configVersion: 1,
      configHash: '0x1',
      mode: 'live',
      minNetProfitUsd: '1',
      minProfitToGasRatio: '1',
      maxPoolUsageRatio: '0.2',
      privateRelayFirst: true,
      publicFallback: false,
      killSwitch: false,
      c2Enabled: true,
      enabledVenues: [],
      enabledAssets: [],
      gasCap: '1',
    },
    state: {
      chainId: 137,
      blockNumber: 100,
      blockHash: '0x2',
      buyPool: 'pool-a',
      sellPool: 'pool-b',
      poolFamily: 'univ2',
      token0: 'USDC',
      token1: 'WETH',
      stateHash: '0x3',
      observedAtMs: Date.now(),
      stateAgeBlocks: 0,
      maxStateAgeBlocks: 3,
    },
    route: {
      borrowAsset: '0x0000000000000000000000000000000000000100',
      borrowAmount: '100',
      steps: [],
      minOut: '101',
      deadline: 123,
      routeHash: 'route-hash',
    },
    executor: '0x0000000000000000000000000000000000000022',
    flashProvider: 'aave',
    encodedRoutePayload: '0x1234',
    borrowAsset: '0x0000000000000000000000000000000000000100',
    borrowAmount: 100n,
    minFinalAmount: 101n,
    deadline: 123,
    signerPrivateKey: '0x11',
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    expiresAtBlock: 110,
    relayEndpoint: 'http://relay',
    publicFallback: false,
    opportunityHash: '0x4',
    payloadHash: '0x5',
    stateHash: '0x3',
    postC1ObservedState: {
      affectedPoolIds: ['pool-a', 'pool-b'],
      postTradeStateHashes: [
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      ],
      realizedProfitUsd: '12.34',
      routeId: 'route-1',
    },
  });

  assert(result.c1StateCommitment.c1StateHash.startsWith('0x'), 'C1 hash must be hex');
  assert(result.evidenceChain.build().c1?.c1StateHash === result.c1StateCommitment.c1StateHash, 'C1 evidence hash mismatch');
}

async function testC2DecisionTruthTableAndGuards(): Promise<void> {
  const submitter = new FakeSubmitter();
  const engine = new C2Engine(submitter);
  const baseReq = {
    opportunityId: 'opp-2',
    cycleId: 'c2-1',
    config: {
      configVersion: 1,
      configHash: '0x1',
      mode: 'live' as const,
      minNetProfitUsd: '5',
      minProfitToGasRatio: '1',
      maxPoolUsageRatio: '0.2',
      privateRelayFirst: true,
      publicFallback: false,
      killSwitch: false,
      c2Enabled: true,
      enabledVenues: [],
      enabledAssets: [],
      gasCap: '1',
    },
    parentC1TxHash: '0xabc',
    parentC1ConfirmedBlock: 100,
    parentC1ReceiptStatus: true,
    postC1State: {
      chainId: 137,
      blockNumber: 101,
      blockHash: '0x2',
      buyPool: 'pool-a',
      sellPool: 'pool-b',
      poolFamily: 'univ2',
      token0: 'USDC',
      token1: 'WETH',
      stateHash: '0x3',
      observedAtMs: Date.now(),
      stateAgeBlocks: 0,
      maxStateAgeBlocks: 3,
    },
    c1StateHash: '0xc1',
    reloadedFromC1StateHash: '0xc1',
    executor: '0x0000000000000000000000000000000000000022',
    signerPrivateKey: '0x11',
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    expiresAtBlock: 110,
    relayEndpoint: 'http://relay',
    publicFallback: false,
    opportunityHash: '0x4',
    payloadHash: '0x5',
  };

  const mirror = {
    route: {
      borrowAsset: 'a',
      borrowAmount: '1',
      steps: [],
      minOut: '1',
      deadline: 1,
      routeHash: 'm',
    },
    encodedRoutePayload: '0x11',
    borrowAsset: 'a',
    borrowAmount: 1n,
    minFinalAmount: 1n,
    deadline: 1,
    netProfitUsd: '8',
    allGatesPassed: true,
  };

  const reverse = {
    ...mirror,
    route: { ...mirror.route, routeHash: 'r' },
    encodedRoutePayload: '0x22',
    netProfitUsd: '7',
  };

  const mirrorResult = await engine.execute({
    ...baseReq,
    mirrorCandidate: mirror,
    reverseCandidate: reverse,
  });
  assert(mirrorResult.decision === 'MIRROR', 'Expected MIRROR decision');

  const reverseResult = await engine.execute({
    ...baseReq,
    mirrorCandidate: { ...mirror, netProfitUsd: '6' },
    reverseCandidate: { ...reverse, netProfitUsd: '9' },
  });
  assert(reverseResult.decision === 'REVERSE', 'Expected REVERSE decision');

  const noopResult = await engine.execute({
    ...baseReq,
    mirrorCandidate: { ...mirror, netProfitUsd: '2' },
    reverseCandidate: { ...reverse, netProfitUsd: '3' },
  });
  assert(noopResult.decision === 'NO_OP' && noopResult.skipped, 'Expected NO_OP result');

  const staleStateResult = await engine.execute({
    ...baseReq,
    postC1State: { ...baseReq.postC1State, blockNumber: 120 },
    mirrorCandidate: mirror,
  });
  assert(staleStateResult.skipped, 'Expected stale state rejection');

  const reuseRejected = await engine.execute({
    ...baseReq,
    mirrorCandidate: {
      ...mirror,
      reuseGuard: { reusedC1Calldata: true },
    },
  });
  assert(reuseRejected.skipped, 'Expected reuse guard rejection');
}

export async function runExecutionLaneTests(): Promise<void> {
  await testC1Commitment();
  await testC2DecisionTruthTableAndGuards();
}

if (require.main === module) {
  runExecutionLaneTests()
    .then(() => {
      process.stdout.write('Execution lane tests passed\n');
    })
    .catch((err) => {
      process.stderr.write(`Execution lane tests failed: ${String(err)}\n`);
      process.exit(1);
    });
}
