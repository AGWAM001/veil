import { errorMessage } from '../../lib/errorMessage';
import { ScreenScaffold } from '@/components/ScreenScaffold';
import { Keypair } from '@stellar/stellar-sdk';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';

import {
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  loadBlendPools,
  loadBlendPositions,
  type BlendPool,
  type BlendPosition,
  type BlendReserve,
} from '../../lib/blend';
import { fundDeposit, loadEarnBalances, type EarnBalances } from '../../lib/earnFunding';
import { useNetwork } from '../../hooks/useNetwork';
import { useWallet } from '../../components/WalletProvider';
import { requirePasskey } from '../../lib/passkey';
import { signAndSubmitSorobanXdr } from '../../lib/sorobanTx';
import { getSignerSecret, getWalletAddress } from '../../lib/walletStore';

/**
 * Earn — supply idle assets to Blend lending pools and redeem them.
 *
 * Deposits run from the spending account. When the money is in the smart
 * wallet instead, the shortfall is moved across first (see lib/earnFunding.ts),
 * so what the user can deposit is what the wallet holds, not what one of its
 * two accounts happens to hold.
 */

const STROOPS = 1e7;

type EarnStep =
  | 'pools'
  | 'deposit-form'
  | 'depositing'
  | 'deposit-done'
  | 'withdraw-form'
  | 'withdrawing'
  | 'withdraw-done'
  | 'error';

function toUnits(stroops: string, fractionDigits: number): string {
  return (Number(stroops) / STROOPS).toFixed(fractionDigits);
}

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatAmount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Map a raw failure onto something the user can act on. */
function describeFailure(error: unknown): string {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes('cancel') || lower.includes('abort')) {
    return 'Passkey cancelled. Please try again.';
  }
  if (lower.includes('utilization') || lower.includes('cap')) {
    return 'Pool is at capacity — deposits temporarily unavailable.';
  }
  return message;
}

type Selected = { pool: BlendPool; reserve: BlendReserve };

export default function EarnRoute() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Subscribed rather than read once at module load: the network is a runtime
  // choice, and everything on this screen belongs to exactly one chain.
  const { network } = useNetwork();
  const { wallet } = useWallet();

  const [step, setStep] = useState<EarnStep>('pools');
  const [accountAddress, setAccountAddress] = useState<string | null>(null);

  const [pools, setPools] = useState<BlendPool[]>([]);
  const [positions, setPositions] = useState<BlendPosition[]>([]);
  const [loadingPools, setLoadingPools] = useState(true);

  const [selected, setSelected] = useState<Selected | null>(null);
  const [balances, setBalances] = useState<EarnBalances | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<BlendPosition | null>(null);

  const [progress, setProgress] = useState('Waiting for passkey…');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const loadData = useCallback(async (address: string) => {
    setLoadingPools(true);
    const [nextPools, nextPositions] = await Promise.all([
      loadBlendPools(),
      loadBlendPositions(address),
    ]);
    setPools(nextPools.filter((pool) => pool.reserves.length > 0));
    setPositions(nextPositions);
    setLoadingPools(false);
  }, []);

  // ── Load session ──
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const walletAddress = await getWalletAddress();
      if (cancelled) return;
      if (!walletAddress) {
        router.replace('/lock');
        return;
      }

      // Blend is called by the spending account, so that key is what has to be
      // present — not just the wallet contract address.
      const signerSecret = await getSignerSecret();
      if (cancelled) return;
      if (!signerSecret) {
        setErrorMsg('Signing key not found. Return to the dashboard and unlock the wallet again.');
        setStep('error');
        setLoadingPools(false);
        return;
      }

      const resolvedAddress = Keypair.fromSecret(signerSecret).publicKey();
      setAccountAddress(resolvedAddress);
      await loadData(resolvedAddress);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, loadData]);

  function openDeposit(pool: BlendPool, reserve: BlendReserve) {
    setSelected({ pool, reserve });
    setBalances(null);
    setDepositAmount('');
    setStep('deposit-form');
    void loadEarnBalances(reserve.code).then(setBalances).catch(() => setBalances(null));
  }

  const available = balances ? balances.inSpending + balances.inWallet : null;
  const parsedAmount = parseFloat(depositAmount);
  const depositIsValid =
    parsedAmount > 0 && (available === null || parsedAmount <= available + 1e-7);

  // ── Deposit ──
  async function handleDeposit() {
    if (!selected || !accountAddress || !depositIsValid) return;
    const { pool, reserve } = selected;
    setProgress('Waiting for passkey…');
    setStep('depositing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Preparing your deposit…');
      await fundDeposit({
        code: reserve.code,
        amount: parsedAmount,
        deploy: wallet.deploy,
        onMoving: () => setProgress(`Moving ${reserve.code} from your wallet…`),
      });

      setProgress('Depositing…');
      const xdr = await buildBlendSupplyXdr({
        poolId: pool.id,
        assetContract: reserve.assetId,
        amountInStroops: BigInt(Math.round(parsedAmount * STROOPS)),
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      setTxHash(hash);
      setStep('deposit-done');
      setDepositAmount('');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  // ── Withdraw ──
  async function handleWithdraw() {
    if (!selectedPosition || !accountAddress) return;
    setProgress('Waiting for passkey…');
    setStep('withdrawing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      setProgress('Withdrawing…');
      const xdr = await buildBlendWithdrawXdr({
        poolId: selectedPosition.poolId,
        assetContract: selectedPosition.asset,
        depositedStroops: BigInt(selectedPosition.deposited),
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        horizonUrl: network.horizonUrl,
      });

      setTxHash(hash);
      setStep('withdraw-done');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  const showLists = step === 'pools';
  const poolName = (poolId: string) => pools.find((p) => p.id === poolId)?.name ?? `${poolId.slice(0, 6)}…`;

  return (
    <ScreenScaffold
      eyebrow="Earn"
      title="Yield on-chain"
      description="Lend USDC or XLM to Blend lending pools and earn interest. Withdraw any time."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      {showLists && positions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Your deposits</Text>
          {positions.map((position) => (
            <View key={`${position.poolId}-${position.asset}`} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{position.code ?? `${position.asset.slice(0, 6)}…`}</Text>
                <Text style={styles.cardMeta}>{poolName(position.poolId)} pool</Text>
              </View>
              <Row
                label="Current value"
                value={`${toUnits(position.deposited, 4)} ${position.code ?? ''}`.trim()}
                accent
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setSelectedPosition(position);
                  setStep('withdraw-form');
                }}
                style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
              >
                <Text style={styles.ghostButtonText}>Withdraw</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {showLists ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Pools</Text>

          {loadingPools ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : pools.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Earn isn't available here yet</Text>
              <Text style={styles.cardMeta}>
                There are no lending pools set up for {network.displayName} in this version of the app.
              </Text>
            </View>
          ) : (
            pools.map((pool) => (
              <View key={pool.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{pool.name}</Text>
                  <Text style={styles.cardMeta}>Blend pool</Text>
                </View>
                {pool.reserves.map((reserve) => (
                  <View key={reserve.assetId} style={styles.reserveRow}>
                    <View style={styles.reserveText}>
                      <Text style={styles.rowValue}>{reserve.code}</Text>
                      <Text style={styles.apy}>{formatApy(reserve.supplyApy)} APY</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Deposit ${reserve.code} in ${pool.name}`}
                      onPress={() => openDeposit(pool, reserve)}
                      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.primaryButtonText}>Deposit</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      ) : null}

      {step === 'deposit-form' && selected ? (
        <View style={styles.section}>
          <View style={styles.card}>
            <Text style={styles.cardMeta}>
              {selected.pool.name} pool · {selected.reserve.code} · est. APY{' '}
              {formatApy(selected.reserve.supplyApy)}
            </Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={depositAmount}
                onChangeText={setDepositAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textFaint}
                keyboardType="decimal-pad"
                accessibilityLabel="Deposit amount"
              />
              <Text style={styles.rowValue}>{selected.reserve.code}</Text>
            </View>
            {available === null ? (
              <Text style={styles.cardMeta}>Checking your balance…</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Use the full available amount"
                onPress={() => setDepositAmount((Math.floor(available * STROOPS) / STROOPS).toString())}
              >
                <Text style={styles.cardMeta}>
                  Available {formatAmount(available)} {selected.reserve.code}{' '}
                  <Text style={styles.link}>Use max</Text>
                </Text>
              </Pressable>
            )}
            {parsedAmount > 0 && available !== null && parsedAmount > available + 1e-7 ? (
              <Text style={styles.warning}>That is more than your wallet holds.</Text>
            ) : null}
            {parsedAmount > 0 ? (
              <Text style={styles.cardMeta}>
                Est. earned in 1 year{' '}
                <Text style={styles.accent}>
                  {formatAmount(parsedAmount * selected.reserve.supplyApy)} {selected.reserve.code}
                </Text>
              </Text>
            ) : null}
            <Text style={styles.cardMeta}>
              The rate moves with how much the pool lends out. Withdrawals return to your spending
              account.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !depositIsValid }}
            disabled={!depositIsValid}
            onPress={handleDeposit}
            style={({ pressed }) => [
              styles.primaryButton,
              !depositIsValid && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Deposit &amp; earn</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'withdraw-form' && selectedPosition ? (
        <View style={styles.section}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              Withdraw {selectedPosition.code ?? 'deposit'} from {poolName(selectedPosition.poolId)}
            </Text>
            <Row
              label="Current value"
              value={`${toUnits(selectedPosition.deposited, 4)} ${selectedPosition.code ?? ''}`.trim()}
              accent
            />
            <Text style={styles.cardMeta}>
              Everything in this deposit, including interest, returns to your spending account.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={handleWithdraw}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.primaryButtonText}>Withdraw all</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'depositing' || step === 'withdrawing' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.cardTitle}>{progress}</Text>
          <Text style={styles.cardMeta}>Keep the app open until this finishes.</Text>
        </View>
      ) : null}

      {step === 'deposit-done' || step === 'withdraw-done' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <Text style={styles.successMark}>✓</Text>
          <Text style={styles.cardTitle}>
            {step === 'deposit-done' ? 'Deposit successful' : 'Withdrawal successful'}
          </Text>
          {txHash ? <Text style={styles.hash}>{txHash}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setStep('pools');
              setTxHash(null);
            }}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.primaryButtonText}>Back to Earn</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'error' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <Text style={styles.errorMark}>!</Text>
          <Text style={styles.cardTitle}>Transaction failed</Text>
          {errorMsg ? <Text style={styles.cardMeta}>{errorMsg}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </ScreenScaffold>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, accent && styles.accent]}>{value}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    section: { gap: 10, marginTop: 12 },
    sectionLabel: {
      color: colors.textMuted,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.4,
      textTransform: 'uppercase',
    },
    card: {
      padding: 18,
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 8,
    },
    centeredCard: { alignItems: 'center', marginTop: 12 },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    cardTitle: { color: colors.textStrong, fontSize: 17, fontWeight: '600' },
    cardMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
    apy: { color: colors.accent, fontSize: 13, fontWeight: '700' },
    accent: { color: colors.positive },
    link: { color: colors.accent, fontWeight: '700' },
    warning: { color: colors.danger, fontSize: 12 },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
    rowLabel: { color: colors.textMuted, fontSize: 13 },
    rowValue: { color: colors.textPrimary, fontSize: 14, textAlign: 'right' },
    reserveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    reserveText: { gap: 2 },
    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    amountInput: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 26,
      paddingVertical: 6,
    },
    primaryButton: {
      marginTop: 6,
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    smallButton: {
      alignItems: 'center',
      paddingVertical: 9,
      paddingHorizontal: 18,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryButtonText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
    ghostButton: {
      marginTop: 6,
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    ghostButtonText: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    centered: { paddingVertical: 24, alignItems: 'center' },
    successMark: { color: colors.positive, fontSize: 34, fontWeight: '700' },
    errorMark: { color: colors.danger, fontSize: 34, fontWeight: '700' },
    hash: {
      color: colors.textMuted,
      fontSize: 11,
      textAlign: 'center',
    },
  });
