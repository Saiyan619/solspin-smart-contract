import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solspin } from "../target/types/solspin";
import { assert, expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";


describe("solspin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solspin as Program<Solspin>;

  it("Admin initialized the Game Vault", async() => {
    const signer = provider.wallet.publicKey;
    const [escrowVaultPDA, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault")],
      program.programId
    );
    const tx = program.methods.initializeHouse().accounts({
      admin: signer,      
    }).rpc();

    const accountInfo = await program.provider.connection.getAccountInfo(escrowVaultPDA);

    assert.ok(accountInfo !== null);
    assert.ok(accountInfo.owner.equals(program.programId)); // Owned by your program
    assert.ok(accountInfo.data.length === 8); // Only Anchor discriminator (space=8)
    console.log("Vault successfully initialized: ", escrowVaultPDA.toBase58());

  })

  // it("Player Initializing game", async() => {

  // })
})






