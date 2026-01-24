use anchor_lang::prelude::*;
use anchor_lang::system_program::{Transfer, transfer};
use switchboard_on_demand::accounts::RandomnessAccountData;

declare_id!("Egeg8KWsUGPMoSE5MnhAto8QrtwenBRQMcgscsQYubuR");
const MAX_RESULTS:u32 = 6;
#[program]
pub mod solspin {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.vrf_acc = Pubkey::default();
        game_state.wager = 0;
        game_state.bump = ctx.bumps.game_state;
        game_state.max_result = MAX_RESULTS;
        game_state.game_vault_bump = ctx.bumps.escrow_vault;
        game_state.player_guess = 0;
        game_state.commit_slot = 0;
        Ok(())
    }

    pub fn call_spin(ctx: Context<CallSpin>, guess:u32, randomness_acc:Pubkey, wager:u64) -> Result<()>{
        require!(wager > 0, ErrorCode::ZeroBet);
        let clock = Clock::get()?;
        let game_state = &mut ctx.accounts.game_state;
         if guess >= MAX_RESULTS {
    return Err(ErrorCode::InvalidGuess.into());}
        game_state.player_guess = guess;
        game_state.wager = wager;
        let random_data: std::cell::Ref<'_, RandomnessAccountData> = RandomnessAccountData::parse(
            ctx.accounts.randomness_data.data.borrow()
        ).unwrap();
        // Check if the data request is still fresh
        if random_data.seed_slot < clock.slot - 5 {
            return Err(ErrorCode::RandomDataExpired.into());
        }
        // Ensure Random data that is already known and is still in process is not overwritten by rebetting
        if !random_data.get_value(clock.slot).is_err(){
            return Err(ErrorCode::RandomDataAlreadyKnown.into());
        }
        game_state.commit_slot = random_data.seed_slot;
        let game_accounts = Transfer{
            from: ctx.accounts.signer.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info()
        };
        let system_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx: CpiContext<'_, '_, '_, '_, Transfer<'_>> = CpiContext::new(system_program, game_accounts);
        transfer(cpi_ctx, game_state.wager)?;
        game_state.vrf_acc = randomness_acc;

        msg!("Spinner as been rolled, results have been requested");
        Ok(())
    }

    pub fn settle_spin(ctx: Context<SettleSpin>) -> Result<()>{
        let clock = Clock::get()?;
        let game_state = &mut ctx.accounts.game_state;
        // SECURITY: Verify randomness account matches stored reference
        if ctx.accounts.randomness_data.key() != game_state.vrf_acc.key(){
            return Err(ErrorCode::WrongRandomDataAcc.into());
        }
        // Parse randomness data
        let random_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_data.data.borrow()
        ).unwrap();
        // SECURITY: Verify seed_slot matches commit
        if random_data.seed_slot != game_state.commit_slot{
            return Err(ErrorCode::RandomDataExpired.into());
        }
        // Get the revealed random value
        let result_value = random_data
        .get_value(clock.slot)
        .map_err(|_| ErrorCode::RandomnessNotResolvedYet)?;
        // Use randomness to determine outcome
        let winning_color = (result_value[0] as u8) % 6;
        let actual_result = winning_color as u32;
        let is_winner = actual_result == game_state.player_guess;
        let payout = game_state.wager.checked_mul(2).ok_or(ErrorCode::Overflow)?;
        let vault = &ctx.accounts.escrow_vault;
        require!(vault.lamports() >= payout,ErrorCode::InsufficientVault);
        if is_winner{
            let transfer_accounts = Transfer{
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.signer.to_account_info()
            };
            // &[&[u8]]
            let seeds = &[b"escrow_vault".as_ref(),&[game_state.game_vault_bump]];
            let signer_seeds = &[&seeds[..]];
            let system_program = ctx.accounts.system_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(system_program, transfer_accounts, signer_seeds);
            transfer(cpi_ctx, payout)?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info>{
    #[account(init,
        payer=signer,
        space= 8 + std::mem::size_of::<GameState>(),
        seeds = [b"game_state", signer.key().as_ref()],
        bump )]
        pub game_state: Account<'info, GameState>,
        
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: Escrow PDA
    #[account(mut,seeds=[b"escrow_vault"], bump)]
    pub escrow_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct CallSpin<'info> {
    #[account(mut,
    seeds=[b"game_state", signer.key().as_ref()],
    bump)]
    pub game_state: Account<'info, GameState>,
    /// CHECK: Escrow PDA
    #[account(mut,seeds=[b"escrow_vault"], bump)]
    pub escrow_vault: AccountInfo<'info>,
    /// CHECK: Validated manually in handler
    pub randomness_data: AccountInfo<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct SettleSpin<'info> {
    #[account(mut,
    seeds=[b"game_state", signer.key().as_ref()], 
    bump)]
    pub game_state: Account<'info, GameState>,
    /// CHECK: Escrow PDA
    #[account(mut,seeds=[b"escrow_vault"], bump)]
    pub escrow_vault: AccountInfo<'info>,
    /// CHECK: Validated manually in handler
    pub randomness_data: AccountInfo<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    system_program: Program<'info, System>
}

#[account]
pub struct GameState{
    player_guess: u32,
    wager: u64,
    vrf_acc: Pubkey,
    bump: u8,
    game_vault_bump: u8,
    max_result: u32,
    commit_slot: u64
}

// #[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
// pub enum ColorGroup{
//     Red,
//     Black,
//     Blue,
//     Green,
//     Purple,
//     Yellow
// }

#[error_code]
pub enum ErrorCode{
    #[msg("Random data request is expired")]
    RandomDataExpired,
    #[msg("Random data request is already known")]
    RandomDataAlreadyKnown,
    #[msg("Wrong Random-data account")]
    WrongRandomDataAcc,
    #[msg("Random data has not been derived yet")]
    RandomnessNotResolvedYet,
    #[msg("This guess is invalid")]
    InvalidGuess,
    #[msg("Calculation Overflow")]
    Overflow,
    #[msg("Zero Bet is not allowed")]
    ZeroBet,
    #[msg("Vault has insufficient Funds")]
    InsufficientVault
}