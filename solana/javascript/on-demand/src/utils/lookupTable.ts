import type { BN } from "@coral-xyz/anchor-30";
import { web3 } from "@coral-xyz/anchor-30";

export function getLutSigner(
  programId: web3.PublicKey,
  pubkey: web3.PublicKey
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("LutSigner"), pubkey.toBuffer()],
    programId
  )[0];
}

export function getLutKey(
  lutSigner: web3.PublicKey,
  lutSlot: number | BN
): web3.PublicKey {
  const [_, lutKey] = web3.AddressLookupTableProgram.createLookupTable({
    authority: lutSigner,
    payer: web3.PublicKey.default,
    recentSlot: BigInt(lutSlot.toString()),
  });
  return lutKey;
}
